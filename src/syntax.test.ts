import { describe, it, expect } from "vitest";
import { tokenizeLine } from "./syntax";

describe("tokenizeLine", () => {
  it("returns the raw line unhighlighted for the 'text' lang", () => {
    const line = "모호한 글자 0O0 · 안녕 Hello";
    expect(tokenizeLine(line, "text")).toEqual([{ text: line }]);
  });

  it("returns the raw line for an unknown lang (no comment marker)", () => {
    const line = "foo bar";
    expect(tokenizeLine(line, "python")).toEqual([{ text: line }]);
  });

  it("tags keyword, number, operator, and comment (rust)", () => {
    const tokens = tokenizeLine("let x = 5; // 주석", "rust");
    expect(tokens.find((t) => t.cls === "tok-keyword")?.text).toBe("let");
    expect(tokens.some((t) => t.cls === "tok-number" && t.text === "5")).toBe(true);
    expect(tokens.some((t) => t.cls === "tok-op")).toBe(true);
    expect(tokens.find((t) => t.cls === "tok-comment")?.text).toBe("// 주석");
  });

  it("uses -- as the haskell comment marker", () => {
    const tokens = tokenizeLine("quicksort [] = [] -- 빈 리스트", "haskell");
    expect(tokens.some((t) => t.cls === "tok-comment" && t.text === "-- 빈 리스트")).toBe(true);
  });

  it("recognizes 0x hex literals as numbers (c)", () => {
    const tokens = tokenizeLine("i = 0x5f3759df - ( i >> 1 );", "c");
    expect(tokens.some((t) => t.cls === "tok-number" && t.text === "0x5f3759df")).toBe(true);
  });

  it("round-trips: concatenated token text equals the input line", () => {
    const cases: Array<[string, string]> = [
      ["const Y = f => f(f); // 콤비네이터", "javascript"],
      ["float x2 = number * 0.5F; // 비트 해킹", "c"],
      ["fn merge<T: Ord>(a: &[T]) -> Vec<T> {", "rust"],
      ["가나다 라마바 · no marker here", "text"],
    ];
    for (const [line, lang] of cases) {
      expect(tokenizeLine(line, lang).map((t) => t.text).join("")).toBe(line);
    }
  });
});
