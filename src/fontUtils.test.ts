import { describe, it, expect } from "vitest";
import { readFamilyName, readUnitsPerEm } from "./fontUtils";

/** 최소 sfnt 바이너리: numTables=1, 유일한 테이블 레코드가 지정 tag, head.unitsPerEm=upem. */
function makeSfnt(tag: string, upem: number): ArrayBuffer {
  const headOffset = 28; // 12(sfnt 헤더) + 16(테이블 레코드 1개)
  const buf = new ArrayBuffer(headOffset + 20);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x00010000); // sfnt version
  dv.setUint16(4, 1); // numTables
  const t = tag.padEnd(4);
  for (let i = 0; i < 4; i++) dv.setUint8(12 + i, t.charCodeAt(i)); // 태그 (rec+0)
  dv.setUint32(20, headOffset); // 테이블 오프셋 (rec+8)
  dv.setUint16(headOffset + 18, upem); // head.unitsPerEm
  return buf;
}

describe("readUnitsPerEm", () => {
  it("reads head.unitsPerEm from a valid sfnt", () => {
    expect(readUnitsPerEm(makeSfnt("head", 1000))).toBe(1000);
    expect(readUnitsPerEm(makeSfnt("head", 2048))).toBe(2048);
  });

  it("returns null when there is no head table", () => {
    expect(readUnitsPerEm(makeSfnt("cmap", 1000))).toBeNull();
  });

  it("returns null for a corrupt/too-short buffer", () => {
    expect(readUnitsPerEm(new ArrayBuffer(4))).toBeNull();
    expect(readUnitsPerEm(new ArrayBuffer(0))).toBeNull();
  });
});

/** name 레코드 스펙 — platformID 3은 UTF-16BE, 그 외는 ASCII/Latin1로 인코딩. */
interface NameRec {
  platformID: number;
  encodingID: number;
  languageID: number;
  nameID: number;
  text: string;
}

function encodeName(platformID: number, text: string): Uint8Array {
  if (platformID === 3) {
    const out = new Uint8Array(text.length * 2); // UTF-16BE (charCodeAt = UTF-16 코드유닛)
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[i * 2] = (c >> 8) & 0xff;
      out[i * 2 + 1] = c & 0xff;
    }
    return out;
  }
  const out = new Uint8Array(text.length); // ASCII/Latin1
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** numTables=1, 유일한 테이블이 'name'. records를 그대로 name 테이블로 직렬화. */
function makeSfntWithName(records: NameRec[]): ArrayBuffer {
  const encoded = records.map((r) => encodeName(r.platformID, r.text));
  const headerSize = 6; // format(u16) + count(u16) + stringOffset(u16)
  const stringOffset = headerSize + records.length * 12;
  const storageSize = encoded.reduce((s, e) => s + e.length, 0);
  const nameTableSize = stringOffset + storageSize;

  const nameTableOffset = 12 + 16; // sfnt 헤더 + 테이블 레코드 1개
  const buf = new ArrayBuffer(nameTableOffset + nameTableSize);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  dv.setUint32(0, 0x00010000); // sfnt version
  dv.setUint16(4, 1); // numTables
  const tag = "name";
  for (let i = 0; i < 4; i++) dv.setUint8(12 + i, tag.charCodeAt(i));
  dv.setUint32(12 + 8, nameTableOffset); // 테이블 오프셋 (rec+8)
  dv.setUint32(12 + 12, nameTableSize); // 테이블 길이 (rec+12)

  dv.setUint16(nameTableOffset + 0, 0); // format
  dv.setUint16(nameTableOffset + 2, records.length); // count
  dv.setUint16(nameTableOffset + 4, stringOffset); // stringOffset

  let cursor = 0;
  records.forEach((r, i) => {
    const rec = nameTableOffset + headerSize + i * 12;
    dv.setUint16(rec + 0, r.platformID);
    dv.setUint16(rec + 2, r.encodingID);
    dv.setUint16(rec + 4, r.languageID);
    dv.setUint16(rec + 6, r.nameID);
    dv.setUint16(rec + 8, encoded[i].length); // length (bytes)
    dv.setUint16(rec + 10, cursor); // offset (stringOffset 기준)
    u8.set(encoded[i], nameTableOffset + stringOffset + cursor);
    cursor += encoded[i].length;
  });
  return buf;
}

const WIN = { platformID: 3, encodingID: 1, languageID: 0x409 };
const MAC = { platformID: 1, encodingID: 0, languageID: 0 };

describe("readFamilyName", () => {
  it("reads Windows nameID 1 (family) as UTF-16BE", () => {
    const buf = makeSfntWithName([{ ...WIN, nameID: 1, text: "Departure Mono" }]);
    expect(readFamilyName(buf)).toBe("Departure Mono");
  });

  it("prefers nameID 16 (typographic family) over nameID 1", () => {
    const buf = makeSfntWithName([
      { ...WIN, nameID: 1, text: "Legacy Family" },
      { ...WIN, nameID: 16, text: "Preferred Family" },
    ]);
    expect(readFamilyName(buf)).toBe("Preferred Family");
  });

  it("prefers Windows over Mac for the same nameID", () => {
    const buf = makeSfntWithName([
      { ...MAC, nameID: 1, text: "Mac Name" },
      { ...WIN, nameID: 1, text: "Win Name" },
    ]);
    expect(readFamilyName(buf)).toBe("Win Name");
  });

  it("falls back to Mac (ASCII) when no Windows record exists", () => {
    const buf = makeSfntWithName([{ ...MAC, nameID: 1, text: "MacRoman Name" }]);
    expect(readFamilyName(buf)).toBe("MacRoman Name");
  });

  it("trims surrounding whitespace", () => {
    const buf = makeSfntWithName([{ ...WIN, nameID: 1, text: "  Spacey  " }]);
    expect(readFamilyName(buf)).toBe("Spacey");
  });

  it("returns null when there is no name table", () => {
    // 'name'이 아닌 테이블만 있는 sfnt (기존 makeSfnt 재사용)
    expect(readFamilyName(makeSfnt("head", 1000))).toBeNull();
  });

  it("returns null for a corrupt/too-short buffer", () => {
    expect(readFamilyName(new ArrayBuffer(4))).toBeNull();
    expect(readFamilyName(new ArrayBuffer(0))).toBeNull();
  });
});
