import { describe, it, expect } from "vitest";
import { instanceChoices, normalizeLocation, selectedChoice } from "./variable";
import type { VariableInfo } from "./types";

const WGHT = { tag: "wght", name: "Weight", min: 100, default: 400, max: 900 };

function info(instances: VariableInfo["instances"], axes = [WGHT]): VariableInfo {
  return { axes, instances };
}

const NAMED = info([
  { name: "Thin", coordinates: { wght: 100 } },
  { name: "Regular", coordinates: { wght: 400 } },
  { name: "Bold", coordinates: { wght: 700 } },
]);

describe("instanceChoices", () => {
  it("lists named instances in fvar order", () => {
    expect(instanceChoices(NAMED).map((c) => c.label)).toEqual(["Thin", "Regular", "Bold"]);
  });

  it("prepends the default when no named instance sits on the axis defaults", () => {
    const choices = instanceChoices(info([{ name: "Bold", coordinates: { wght: 700 } }]));
    expect(choices.map((c) => c.label)).toEqual(["기본값", "Bold"]);
    expect(choices[0].location).toEqual({ wght: 400 });
  });

  it("offers only the default when the font has no named instances", () => {
    expect(instanceChoices(info([])).map((c) => c.label)).toEqual(["기본값"]);
  });

  it("labels unnamed instances by their coordinates", () => {
    const choices = instanceChoices(info([{ name: "", coordinates: { wght: 650 } }]));
    expect(choices[1].label).toBe("wght 650");
  });
});

describe("normalizeLocation", () => {
  it("maps the axis defaults to null so default and 'unselected' share one cache key", () => {
    expect(normalizeLocation({ wght: 400 }, NAMED)).toBeNull();
    expect(normalizeLocation(null, NAMED)).toBeNull();
  });

  it("keeps non-default locations with tags sorted for a deterministic key", () => {
    const wdth = { tag: "wdth", name: "Width", min: 75, default: 100, max: 100 };
    const two = info([], [WGHT, wdth]);
    const result = normalizeLocation({ wght: 700, wdth: 100 }, two);
    expect(result).toEqual({ wdth: 100, wght: 700 });
    expect(Object.keys(result!)).toEqual(["wdth", "wght"]);
  });

  it("returns null for a static font", () => {
    expect(normalizeLocation({ wght: 700 }, undefined)).toBeNull();
  });
});

describe("selectedChoice", () => {
  it("resolves null to the default entry", () => {
    expect(selectedChoice(null, NAMED, instanceChoices(NAMED))).toBe(1);
  });

  it("finds the entry matching the chosen location", () => {
    expect(selectedChoice({ wght: 700 }, NAMED, instanceChoices(NAMED))).toBe(2);
  });
});
