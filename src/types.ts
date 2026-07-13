// 도메인 타입 + 기본 상수 — 순수 값/타입만(로직·React 없음). App.tsx·FontSlot.tsx가 소비.
// BasicOpts/MonoOpts의 키 순서는 App.buildOptions의 객체 리터럴이 결정하므로, 여기 인터페이스
// 순서를 바꿔도 캐시 키 결정성에는 영향이 없다.

export interface LoadedFont {
  family: string;
  fileName: string;
  upem: number | null; // head.unitsPerEm (파싱 실패 시 null)
  familyName?: string; // name 테이블 패밀리 이름(없으면 파일명 stem) — 기본 출력 이름 생성용
  monospace?: boolean; // 사이드카 inspect 판정 — undefined = 미판정/실패(배지 미표시)
  convertedFromOtf?: boolean; // 사이드카 inspect 판정 — OTF(CFF) 입력, 병합 시 TTF로 변환됨
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

// 슬롯 역할은 모드에 따라 다르다 — basic: 우선(A)+보충(B) 커버리지 규칙 / mono: A는
// 전체 보존되는 고정폭 베이스, B는 CJK만 셀에 맞춰 공급(B의 라틴은 안 들어옴).
// title/desc는 빈 슬롯(드롭 유도)용, role은 로드된 슬림 행("역할 · upem N")용 — 순수 표시 문구.
export const SLOT_INFO: Record<MergeMode, Record<SlotId, { title: string; desc: string; role: string }>> = {
  basic: {
    a: { title: "A · 우선 폰트", desc: "겹치는 글리프는 A가 우선 · 보통 영문", role: "우선 · 겹치는 글리프 담당" },
    b: { title: "B · 보충 폰트", desc: "A에 없는 글리프 전부 담당 · 보통 한글", role: "보충 · A에 없는 글리프 담당" },
  },
  mono: {
    a: { title: "A · 베이스 폰트", desc: "고정폭 영문 — 전체 보존 · 라틴·리가처 담당", role: "베이스 · 고정폭 영문 보존" },
    b: { title: "B · 한글 폰트", desc: "한글·CJK만 셀에 맞춰 공급 · 라틴은 안 들어옴", role: "공급 · 한글·CJK 셀 이식" },
  },
};

export type MergeMode = "basic" | "mono";
export type Style = "Regular" | "Bold" | "Italic" | "Bold Italic";

/** 일반 병합(basic): fontTools Merger로 A·B를 합치고 라틴을 base가 이긴다.
 *  cjk는 겹치는 CJK(한글·한자·전각)만 별도로 가질 폰트 — base와 다르면 병합 전
 *  지는 쪽 cmap에서 교집합 CJK를 제거해 first-wins를 우회한다. */
export interface BasicOpts {
  base: "A" | "B";
  cjk: "A" | "B";
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

// cjk 기본 "B": 이 툴의 목적(영문 A + 한글 B)상 기대 동작이고, A에 CJK가 없으면
// (대부분) 제거 대상이 공집합이라 종전 출력과 동일하다.
export const BASIC_DEFAULTS: BasicOpts = { base: "A", cjk: "B", upem: null };
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
