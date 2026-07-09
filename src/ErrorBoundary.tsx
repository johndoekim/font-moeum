import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

// 렌더/이벤트 핸들러에서 예외가 나도 앱 전체가 블랭크가 되지 않도록 하는 최소 방어벽.
// (예: 이벤트 값을 setState 업데이터 안에서 읽어 e.currentTarget이 null이 되는 류의 버그)
interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("앱 오류:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="error-fallback">
          <h1>앗, 오류가 발생했어요</h1>
          <pre>{error.message || String(error)}</pre>
          <button onClick={() => window.location.reload()}>다시 시작</button>
        </div>
      );
    }
    return this.props.children;
  }
}
