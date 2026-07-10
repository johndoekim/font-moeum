import { describe, it, expect } from "vitest";
import { buildStatus, num, type StatusInput } from "./status";

const base: StatusInput = {
  mergeError: null,
  merging: false,
  mode: "basic",
  notice: null,
  merged: null,
  mergedMode: null,
  stats: null,
  baseFont: null,
  basicOptsBase: "A",
  cjkFont: null,
  basicOptsCjk: "B",
  fontsA: null,
  fontsB: null,
};

describe("num", () => {
  it("passes numbers through, coerces everything else to 0", () => {
    expect(num(5)).toBe(5);
    expect(num("5")).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num(null)).toBe(0);
  });
});

describe("buildStatus", () => {
  it("idle: prompts to upload both when nothing is loaded", () => {
    const { text, className } = buildStatus(base);
    expect(text).toContain("TTF/OTF를 올리면");
    expect(className).toBe("sb-item");
  });

  it("error wins over everything and is styled sb-error", () => {
    const r = buildStatus({
      ...base,
      mergeError: "boom",
      merging: true,
      merged: { family: "m", fileName: "x", upem: null },
    });
    expect(r.text).toBe("boom");
    expect(r.className).toBe("sb-item sb-error");
  });

  it("merging shows mode-specific text", () => {
    expect(buildStatus({ ...base, merging: true, mode: "basic" }).text).toContain("첫 병합은");
    expect(buildStatus({ ...base, merging: true, mode: "mono" }).text).toContain("코딩 폰트 병합 중");
  });

  it("notice is shown and styled ok", () => {
    const r = buildStatus({ ...base, notice: "저장됨: /x.ttf" });
    expect(r.text).toBe("저장됨: /x.ttf");
    expect(r.className).toBe("sb-item sb-ok");
  });

  it("merged basic: shows preview text + latin-priority file, styled ok", () => {
    const r = buildStatus({
      ...base,
      merged: { family: "merged-1", fileName: "MoeumMerged", upem: null },
      mergedMode: "basic",
      baseFont: { family: "a", fileName: "Inter.ttf", upem: 2048 },
    });
    expect(r.text).toContain("병합 미리보기");
    expect(r.text).toContain("Inter.ttf");
    expect(r.className).toBe("sb-item sb-ok");
  });

  it("merged basic: shows CJK owner when it differs from base", () => {
    const r = buildStatus({
      ...base,
      merged: { family: "merged-1", fileName: "MoeumMerged", upem: null },
      mergedMode: "basic",
      baseFont: { family: "a", fileName: "Inter.ttf", upem: 2048 },
      cjkFont: { family: "b", fileName: "D2Coding.ttf", upem: 1000 },
      basicOptsBase: "A",
      basicOptsCjk: "B",
    });
    expect(r.text).toContain("라틴 담당: Inter.ttf");
    expect(r.text).toContain("CJK 담당: D2Coding.ttf");
  });

  it("merged basic: omits CJK owner when it matches base", () => {
    const r = buildStatus({
      ...base,
      merged: { family: "merged-1", fileName: "MoeumMerged", upem: null },
      mergedMode: "basic",
      baseFont: { family: "a", fileName: "Inter.ttf", upem: 2048 },
      basicOptsBase: "A",
      basicOptsCjk: "A",
    });
    expect(r.text).not.toContain("CJK");
  });

  it("pre-merge preview text is mode-aware", () => {
    const both = {
      fontsA: { family: "a", fileName: "a.ttf", upem: 1000 },
      fontsB: { family: "b", fileName: "b.ttf", upem: 1000 },
    };
    expect(buildStatus({ ...base, ...both, mode: "basic" }).text).toContain("A 우선 + B 보충");
    expect(buildStatus({ ...base, ...both, mode: "mono" }).text).toContain("A 베이스 + B 한글");
    expect(buildStatus({ ...base, mode: "basic" }).text).toContain("우선(A)·보충(B)");
    expect(buildStatus({ ...base, mode: "mono" }).text).toContain("베이스(A)·한글(B)");
  });

  it("merged mono: reports copied glyph counts from stats", () => {
    const r = buildStatus({
      ...base,
      merged: { family: "merged-1", fileName: "MoeumMono", upem: null },
      mergedMode: "mono",
      stats: { copied: 3000, hanja_copied: 500, capped: 12, ccmp_rules: 40 },
    });
    expect(r.text).toContain("글리프 3,000개 복사");
    expect(r.text).toContain("한자 500");
    expect(r.text).toContain("자동 축소 12");
    expect(r.text).toContain("자모 규칙 40개");
  });
});
