import type { StatusDot } from "./status";

// 하단 상태바 — 순수 표현 leaf. 상태 문구/클래스/점 색은 App이 buildStatus로 파생해 넘겨주므로
// crown-jewel 로직이 이 경계를 넘지 않는다.
export function StatusBar({
  statusText,
  statusClass,
  dot,
  cursor,
  fontSize,
  lineHeight,
  langLabel,
}: {
  statusText: string;
  statusClass: string;
  dot: StatusDot;
  cursor: { ln: number; col: number };
  fontSize: number;
  lineHeight: number;
  langLabel: string;
}) {
  return (
    <footer className="statusbar">
      <span className="sb-status">
        <span className={`sb-dot sb-dot-${dot}`} />
        <span className={statusClass}>{statusText}</span>
      </span>
      <span className="sb-right">
        <span className="sb-item">
          Ln {cursor.ln}, Col {cursor.col}
        </span>
        <span className="sb-item">
          {fontSize}px · {lineHeight.toFixed(2)}
        </span>
        <span className="sb-item">UTF-8</span>
        <span className="sb-item">{langLabel}</span>
      </span>
    </footer>
  );
}
