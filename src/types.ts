// 도메인 타입 + 기본 상수 — 순수 값/타입만(로직·React 없음). App.tsx·FontSlot.tsx가 소비.
// BasicOpts/MonoOpts의 키 순서는 App.buildOptions의 객체 리터럴이 결정하므로, 여기 인터페이스
// 순서를 바꿔도 캐시 키 결정성에는 영향이 없다.

export interface LoadedFont {
  family: string;
  fileName: string;
  upem: number | null; // head.unitsPerEm (파싱 실패 시 null)
}

/** 병합 결과 캐시 항목 — 같은 (A업로드, B업로드, 옵션) 조합은 재병합 없이 복원.
 *  stats는 사이드카가 돌려준 통계(mono)/{mode:"basic"} — 캐시 복원 시 상태바에 재사용. */
export interface MergedEntry {
  seqA: number;
  seqB: number;
  family: string;
  face: FontFace;
  bytes: ArrayBuffer;
  stats: unknown;
}

export type SlotId = "a" | "b";

// 병합 규칙은 언어가 아니라 "우선순위 + 커버리지": 겹치는 글리프는 A가 이기고,
// B는 A에 없는 나머지 전부를 채운다. 영문→A, 한글→B는 대표 사용례일 뿐.
// title/desc는 빈 슬롯(드롭 유도)용, role은 로드된 슬림 행("역할 · upem N")용 — 순수 표시 문구.
export const SLOT_INFO: Record<SlotId, { title: string; desc: string; role: string }> = {
  a: { title: "A · 우선 폰트", desc: "겹치는 글리프는 A가 이김 · 보통 영문", role: "우선 · 겹치면 이김" },
  b: { title: "B · 보충 폰트", desc: "A에 없는 글리프 전부 담당 · 보통 한글", role: "보충 · 없으면 담당" },
};

export type MergeMode = "basic" | "mono";
export type Style = "Regular" | "Bold" | "Italic" | "Bold Italic";

/** 일반 병합(basic): fontTools Merger로 A·B를 합치고 라틴을 base가 이긴다. */
export interface BasicOpts {
  base: "A" | "B";
  upem: number | null; // null = 자동(더 큰 UPM)
}
/** 코딩 폰트(mono): 고정폭 A에 한글 B를 셀에 맞춰 스케일·복사. */
export interface MonoOpts {
  koreanScale: number; // 0.80–1.40
  widthMult: number; // 2.0 | 1.5
  ty: number; // −0.10–0.10 (em)
  includeHanja: boolean;
  fullwidth: "A" | "B";
  jamoCcmp: boolean;
}

export const BASIC_DEFAULTS: BasicOpts = { base: "A", upem: null };
export const MONO_DEFAULTS: MonoOpts = {
  koreanScale: 1.15,
  widthMult: 2.0,
  ty: 0,
  includeHanja: true,
  fullwidth: "B",
  jamoCcmp: true,
};
export const DEFAULT_NAMES: Record<MergeMode, string> = { basic: "MoeumMerged", mono: "MoeumMono" };
export const STYLES: Style[] = ["Regular", "Bold", "Italic", "Bold Italic"];
// unitsPerEm 입력의 합리적 양수 범위 — 벗어나면 scale_upem에 깨진 값이 흘러가지 않도록 자동(null)로 폴백.
export const UPEM_MIN = 16;
export const UPEM_MAX = 16384;
