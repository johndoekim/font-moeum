import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";

// 커서 위치(Ln/Col) 추적 + 현재 줄 하이라이트 — contentEditable은 React가 자식을 다시 그리면
// 편집 내용이 깨지므로 클래스는 DOM에 직접 토글한다(crown A). previewRef는 App에 선언·attach된
// 채로 넘어오고, effect는 이벤트 시점에 previewRef.current를 lazy하게 읽으므로 stale closure가
// 없다. deps는 []로, 리스너는 마운트당 한 번만 등록된다.
export function useCursorTracking(previewRef: RefObject<HTMLDivElement | null>) {
  const [cursor, setCursor] = useState({ ln: 1, col: 1 });

  useEffect(() => {
    function onSelectionChange() {
      const preview = previewRef.current;
      const sel = document.getSelection();
      if (!preview || !sel?.anchorNode || !preview.contains(sel.anchorNode)) return;

      let node: Node | null = sel.anchorNode;
      let lineEl: Node | null = null;
      while (node && node !== preview) {
        if (node.parentNode === preview) {
          lineEl = node;
          break;
        }
        node = node.parentNode;
      }
      const lines = Array.from(preview.children);
      const idx = lineEl ? lines.indexOf(lineEl as Element) : 0;
      lines.forEach((el, i) => el.classList.toggle("active-line", i === idx));
      // 하이라이트 span이 있어도 정확한 컬럼: 줄 시작 → 커서까지의 텍스트 길이
      let col = (sel.anchorOffset ?? 0) + 1;
      if (lineEl) {
        try {
          const range = document.createRange();
          range.setStart(lineEl, 0);
          range.setEnd(sel.anchorNode, sel.anchorOffset);
          col = range.toString().length + 1;
        } catch {
          /* 폴백: anchorOffset */
        }
      }
      setCursor({ ln: Math.max(idx, 0) + 1, col });
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [previewRef]);

  // 샘플 탭 전환 시 커서를 1,1로 되돌린다(편집 리셋은 preview div의 key remount가 담당).
  const resetCursor = useCallback(() => setCursor({ ln: 1, col: 1 }), []);

  return { cursor, resetCursor };
}
