import { describe, it, expect } from "vitest";
import { readUnitsPerEm } from "./fontUtils";

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
