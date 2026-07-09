// 의도적으로 최소 구성 — Hooks 규칙만 켠다. 이 저장소의 로드-베어링 스케줄러 effect(App.tsx의
// 자동 재병합)에는 의도적인 `eslint-disable react-hooks/exhaustive-deps`가 있고, 그 밖의
// effect들이 잘못된 deps 편집으로 조용히 깨지는 것을 막는 게 목적이다. 전체 스타일/타입 린트는
// 일부러 도입하지 않는다(과설계 방지 + 의도적 disable을 '고쳐' 병합 루프를 깨뜨리지 않도록).
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "node_modules"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
