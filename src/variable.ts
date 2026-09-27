// 가변 폰트 인스턴스 선택 — 순수 함수(React 무관). 슬롯 드롭다운 목록과, 병합 옵션
// instance_a/b의 정규화(캐시 키 결정성)를 담당한다. 실제 고정은 사이드카(resolve_instance).
import type { AxisLocation, VariableInfo } from "./types";

export interface InstanceChoice {
  label: string;
  location: AxisLocation;
}

function defaultLocation(info: VariableInfo): AxisLocation {
  return Object.fromEntries(info.axes.map((a) => [a.tag, a.default]));
}

function sameLocation(x: AxisLocation, y: AxisLocation, info: VariableInfo): boolean {
  return info.axes.every((a) => (x[a.tag] ?? a.default) === (y[a.tag] ?? a.default));
}

function formatLocation(loc: AxisLocation): string {
  return Object.entries(loc)
    .map(([tag, v]) => `${tag} ${v}`)
    .join(" · ");
}

/** 드롭다운 항목 = fvar의 이름 붙은 인스턴스(Thin…Black). 축 기본값에 해당하는 항목이
 *  없으면 맨 앞에 "기본값"을 넣어, 선택 안 함(null)도 항상 목록의 한 칸으로 보이게 한다. */
export function instanceChoices(info: VariableInfo): InstanceChoice[] {
  const named = info.instances.map((i) => ({
    label: i.name || formatLocation(i.coordinates),
    location: i.coordinates,
  }));
  const defaults = defaultLocation(info);
  return named.some((c) => sameLocation(c.location, defaults, info))
    ? named
    : [{ label: "기본값", location: defaults }, ...named];
}

/** 병합 옵션용 정규화 — 축 기본값이면 null(사이드카가 어차피 기본값으로 고정), 아니면
 *  축 태그 정렬 객체. 같은 결과물에 캐시 키가 둘 생기지 않게 한다. 정적 폰트는 null. */
export function normalizeLocation(
  loc: AxisLocation | null,
  info: VariableInfo | undefined,
): AxisLocation | null {
  if (!loc || !info || sameLocation(loc, defaultLocation(info), info)) return null;
  const out: AxisLocation = {};
  for (const axis of [...info.axes].sort((x, y) => x.tag.localeCompare(y.tag)))
    out[axis.tag] = loc[axis.tag] ?? axis.default;
  return out;
}

/** 현재 선택(null = 기본값)에 해당하는 choices 인덱스. 없으면 -1. */
export function selectedChoice(
  loc: AxisLocation | null,
  info: VariableInfo,
  choices: InstanceChoice[],
): number {
  const target = loc ?? defaultLocation(info);
  return choices.findIndex((c) => sameLocation(c.location, target, info));
}
