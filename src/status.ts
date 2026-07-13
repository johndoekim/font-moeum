// 상태바 뷰-모델 셀렉터 — App.tsx 렌더 본문에 있던 큰 삼항을 순수 함수로 분리(테스트 가능).
import type { LoadedFont, MergeMode } from "./types";

/** stats(unknown)에서 숫자만 안전하게 꺼낸다 (문자열·undefined·null → 0) */
export function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

export interface StatusInput {
  mergeError: string | null;
  merging: boolean;
  mode: MergeMode;
  notice: string | null;
  merged: LoadedFont | null;
  mergedMode: MergeMode | null;
  stats: unknown;
  baseFont: LoadedFont | null;
  basicOptsBase: "A" | "B";
  cjkFont: LoadedFont | null;
  basicOptsCjk: "A" | "B";
  fontsA: LoadedFont | null;
  fontsB: LoadedFont | null;
}

// 현재 미리보기 중인 병합의 통계로 상태바 문구·클래스를 만든다. 모드 판정은 stats.mode가
// 아니라 mergedMode(병합 시점의 mode)로 한다 — get_merge_stats가 실패해 stats가 null이어도
// 문구가 어긋나지 않는다.
export type StatusDot = "ok" | "error" | "preview" | "idle";

export function buildStatus(s: StatusInput): { text: string; className: string; dot: StatusDot } {
  const st = s.stats as Record<string, unknown> | null;
  const text = s.mergeError
    ? s.mergeError
    : s.merging
      ? s.mode === "mono"
        ? "코딩 폰트 병합 중… 글리프 스케일·합성"
        : "병합 중… 첫 병합은 몇 초 걸립니다"
      : s.notice
        ? s.notice
        : s.merged
          ? s.mergedMode === "mono"
            ? `${s.merged.fileName} · 글리프 ${num(st?.copied).toLocaleString("ko-KR")}개 복사` +
              (num(st?.hanja_copied) ? ` (한자 ${num(st?.hanja_copied).toLocaleString("ko-KR")})` : "") +
              ` · 자동 축소 ${num(st?.capped)}개` +
              (num(st?.ccmp_rules) ? ` · 자모 규칙 ${num(st?.ccmp_rules)}개` : "")
            : `병합 미리보기 — ${s.merged.fileName} · 라틴 담당: ${s.baseFont?.fileName ?? `${s.basicOptsBase} 슬롯`}` +
              // cjk === base면 라틴 담당 표기가 전체 우선을 이미 함의 — 중복 표기 회피
              (s.basicOptsCjk !== s.basicOptsBase
                ? ` · CJK 담당: ${s.cjkFont?.fileName ?? `${s.basicOptsCjk} 슬롯`}`
                : "")
          : s.fontsA && s.fontsB
            ? s.mode === "mono"
              ? "A 베이스 + B 한글 조합 미리보기 중 (병합 전 근사치)"
              : "A 우선 + B 보충 조합 미리보기 중 (병합 전 근사치)"
            : s.fontsA || s.fontsB
              ? "폰트 1개 적용 중 — 나머지 슬롯도 채우면 함께 미리 볼 수 있습니다"
              : s.mode === "mono"
                ? "베이스(A)·한글(B) TTF/OTF를 올리면 함께 미리 볼 수 있습니다"
                : "우선(A)·보충(B) TTF/OTF를 올리면 함께 미리 볼 수 있습니다";
  const className = s.mergeError
    ? "sb-item sb-error"
    : s.merged || s.notice
      ? "sb-item sb-ok"
      : "sb-item";
  // 상태 점 색 — className과 같은 분기에서 파생(뷰에 로직 중복 없음).
  // 녹색=병합/안내, 빨강=에러, 보라=병합 중·두 폰트 미리보기, 흐림=빈/단일 슬롯.
  const dot: StatusDot = s.mergeError
    ? "error"
    : s.merged || s.notice
      ? "ok"
      : s.merging || (s.fontsA && s.fontsB)
        ? "preview"
        : "idle";
  return { text, className, dot };
}
