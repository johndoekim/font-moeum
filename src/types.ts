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
  variable?: VariableInfo; // 사이드카 inspect 판정 — 가변 폰트(fvar)의 축·이름 붙은 인스턴스
}

/** 가변 폰트 축 좌표 — {wght: 700}. 사이드카 instance_a/b로 그대로 전달된다. */
export type AxisLocation = Record<string, number>;

/** 사이드카 inspect의 variable 필드 (merge.py variable_info). */
export interface VariableInfo {
  axes: { tag: string; name: string; min: number; default: number; max: number }[];
  instances: { name: string; coordinates: AxisLocation }[];
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

/** 글자 범위(서브셋 프리셋) — 병합 후 한글 음절·한자만 덜어낸다(subset_presets.py). 라틴·기호는 전부 유지. */
export type SubsetPreset = "none" | "no_hanja" | "ksx1001";
export const SUBSET_PRESETS: Record<SubsetPreset, { label: string; hint: string }> = {
  none: { label: "전체", hint: "병합된 글자를 모두 유지" },
  no_hanja: { label: "한자 제외", hint: "한자(CJK 통합·확장 A·호환)를 뺍니다" },
  ksx1001: {
    label: "KS X 1001",
    hint: "한자를 빼고 한글을 완성형 2,350자로 줄입니다 — 웹폰트 용량 절감용. 빠진 글자는 미리보기에 □로 보입니다",
  },
};

/** 저장 형식 — 병합 결과는 항상 TTF, WOFF2는 저장 시점에 사이드카가 압축한다(캐시·재병합 무관). */
export type ExportFormat = "ttf" | "woff2";
export const EXPORT_FORMATS: Record<ExportFormat, { label: string; filter: string; hint: string }> = {
  ttf: { label: "TTF", filter: "TrueType Font", hint: "설치용 데스크톱 폰트" },
  woff2: { label: "WOFF2", filter: "Web Open Font Format 2", hint: "웹폰트용 압축 형식 — @font-face에 사용" },
};
// unitsPerEm 입력의 합리적 양수 범위 — 벗어나면 scale_upem에 깨진 값이 흘러가지 않도록 자동(null)로 폴백.
export const UPEM_MIN = 16;
export const UPEM_MAX = 16384;
