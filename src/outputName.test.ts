import { describe, it, expect } from "vitest";
import { deriveDefaultName } from "./outputName";
import type { LoadedFont, SlotId } from "./types";

/** familyName만 의미 있는 최소 LoadedFont. */
function font(familyName: string): LoadedFont {
  return { family: "", fileName: "", upem: null, familyName };
}

function slots(a: LoadedFont | null, b: LoadedFont | null): Record<SlotId, LoadedFont | null> {
  return { a, b };
}

describe("deriveDefaultName", () => {
  it("joins A and B family names, stripping inner whitespace, with a hyphen", () => {
    const result = deriveDefaultName(
      slots(font("Departure Mono"), font("LXGW WenKai Mono KR")),
      "basic",
    );
    expect(result).toBe("DepartureMono-LXGWWenKaiMonoKR");
  });

  it("uses only the loaded slot when one side is empty", () => {
    expect(deriveDefaultName(slots(font("Departure Mono"), null), "basic")).toBe("DepartureMono");
    expect(deriveDefaultName(slots(null, font("LXGW WenKai Mono KR")), "basic")).toBe(
      "LXGWWenKaiMonoKR",
    );
  });

  it("falls back to the mode's static default when no fonts are loaded", () => {
    expect(deriveDefaultName(slots(null, null), "basic")).toBe("MoeumMerged");
    expect(deriveDefaultName(slots(null, null), "mono")).toBe("MoeumMono");
  });

  it("ignores a font whose familyName is missing or empty", () => {
    const noName: LoadedFont = { family: "", fileName: "", upem: null };
    expect(deriveDefaultName(slots(noName, font("Nanum Gothic")), "basic")).toBe("NanumGothic");
    expect(deriveDefaultName(slots(noName, null), "mono")).toBe("MoeumMono");
  });
});
