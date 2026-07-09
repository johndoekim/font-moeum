import type { ReactNode } from "react";

// 접이식 사이드바 섹션 — VS Code 탐색기 그룹 느낌. 상태(open)는 App이 소유하고 이 컴포넌트는
// 순수 표현만. actions(예: 슬롯 헤더의 ⇅ 스왑)는 토글 버튼의 형제로 렌더한다 — 버튼 중첩은
// 잘못된 HTML이라 키보드/클릭 동작이 깨진다.
export function SidebarSection({
  title,
  open,
  onToggle,
  actions,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sb-section">
      <div className="sb-section-header">
        <button
          type="button"
          className="sb-section-toggle"
          onClick={onToggle}
          aria-expanded={open}
        >
          <span className="sb-chevron">{open ? "▾" : "▸"}</span>
          <span className="sb-section-title">{title}</span>
        </button>
        {actions && <div className="sb-section-actions">{actions}</div>}
      </div>
      {open && <div className="sb-section-body">{children}</div>}
    </section>
  );
}
