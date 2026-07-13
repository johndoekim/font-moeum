// 순수 sfnt(폰트 바이너리) 유틸 — React·앱 상태와 무관, 단독 테스트 가능.

/** sfnt 테이블 디렉터리에서 head.unitsPerEm(uint16 BE)만 읽는다. 실패 시 null.
 *  FontFace.load()로 이미 검증된 뒤 호출하므로 정상 sfnt가 전제 — 손상 시 null 폴백. */
export function readUnitsPerEm(buffer: ArrayBuffer): number | null {
  try {
    const dv = new DataView(buffer);
    const numTables = dv.getUint16(4); // sfnt 헤더의 numTables
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16; // 테이블 레코드 16바이트씩
      // 태그 'head' = 0x68656164
      if (dv.getUint32(rec) === 0x68656164) {
        const off = dv.getUint32(rec + 8); // head 테이블 오프셋
        return dv.getUint16(off + 18); // head 안의 unitsPerEm 위치
      }
    }
  } catch {
    /* 손상/비정상 sfnt → null 폴백 */
  }
  return null;
}

/** sfnt 'name' 테이블에서 패밀리 이름을 읽는다. nameID 16(Typographic Family) 우선,
 *  없으면 nameID 1(Family). 플랫폼은 Windows(3, UTF-16BE) 우선 → Mac(1, ASCII) 폴백.
 *  못 읽으면 null(호출부가 파일명으로 폴백). FontFace.load()로 검증된 뒤 호출되므로
 *  정상 sfnt 전제 — 손상/비정상은 null. */
export function readFamilyName(buffer: ArrayBuffer): string | null {
  try {
    const dv = new DataView(buffer);
    const numTables = dv.getUint16(4);
    let nameOffset = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (dv.getUint32(rec) === 0x6e616d65) {
        // 'name'
        nameOffset = dv.getUint32(rec + 8);
        break;
      }
    }
    if (nameOffset < 0) return null;

    const count = dv.getUint16(nameOffset + 2);
    const stringBase = nameOffset + dv.getUint16(nameOffset + 4);

    // 후보를 점수로 골라 가장 좋은 하나만 디코드. 점수 = platScore*10 + idScore →
    // 16/win > 1/win > 16/mac > 1/mac > 16/기타 > 1/기타 (spec 우선순위와 동일).
    let best: { score: number; off: number; len: number; win: boolean } | null = null;
    for (let i = 0; i < count; i++) {
      const rec = nameOffset + 6 + i * 12;
      const platformID = dv.getUint16(rec);
      const nameID = dv.getUint16(rec + 6);
      if (nameID !== 1 && nameID !== 16) continue;
      const len = dv.getUint16(rec + 8);
      const off = dv.getUint16(rec + 10);
      const idScore = nameID === 16 ? 2 : 1;
      const platScore = platformID === 3 ? 2 : platformID === 1 ? 1 : 0;
      const score = platScore * 10 + idScore;
      if (!best || score > best.score) {
        best = { score, off: stringBase + off, len, win: platformID === 3 };
      }
    }
    if (!best) return null;

    const bytes = new Uint8Array(buffer, best.off, best.len);
    let text = "";
    if (best.win) {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]); // UTF-16BE
      }
    } else {
      for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]); // ASCII
    }
    return text.trim() || null;
  } catch {
    return null;
  }
}
