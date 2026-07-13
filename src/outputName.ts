// 기본 출력 이름 조합 — 순수 함수(React·앱 상태 무관, 단독 테스트 가능).
import { DEFAULT_NAMES } from "./types";
import type { LoadedFont, MergeMode, SlotId } from "./types";

/** 로드된 A·B 폰트의 패밀리 이름으로 기본 출력 이름 생성 — 각 이름의 공백을 제거하고 '-'로 연결.
 *  로드된(이름 있는) 폰트가 없으면 모드별 정적 기본값 DEFAULT_NAMES[mode]. */
export function deriveDefaultName(
  fonts: Record<SlotId, LoadedFont | null>,
  mode: MergeMode,
): string {
  const parts = (["a", "b"] as const)
    .map((s) => fonts[s]?.familyName?.replace(/\s+/g, ""))
    .filter((n): n is string => !!n);
  return parts.length ? parts.join("-") : DEFAULT_NAMES[mode];
}
