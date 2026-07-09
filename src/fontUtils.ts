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
