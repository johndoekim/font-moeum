import { useRef, useState } from "react";
import "./App.css";

const SAMPLE_TEXT = "안녕하세요 Hello 123 반갑습니다 Typography";

interface LoadedFont {
  family: string;
  fileName: string;
}

function App() {
  const [loadedFont, setLoadedFont] = useState<LoadedFont | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 같은 파일을 다시 골라도 새 face가 이기도록 패밀리 이름에 시퀀스를 붙이고,
  // 이전 face는 document.fonts에서 제거한다 (캐시 충돌 방지).
  const prevFaceRef = useRef<FontFace | null>(null);
  const faceSeqRef = useRef(0);

  async function loadFontFile(file: File) {
    try {
      const buffer = await file.arrayBuffer();
      const family = `preview-${++faceSeqRef.current}`;
      const face = new FontFace(family, buffer);
      await face.load();
      if (prevFaceRef.current) {
        document.fonts.delete(prevFaceRef.current);
      }
      document.fonts.add(face);
      prevFaceRef.current = face;
      setLoadedFont({ family, fileName: file.name });
      setError(null);
    } catch {
      setError(`폰트를 로드하지 못했습니다: ${file.name}`);
    }
  }

  return (
    <main className="app">
      <header className="toolbar">
        <label className="file-button">
          TTF 선택
          <input
            type="file"
            accept=".ttf"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) loadFontFile(file);
            }}
          />
        </label>
        <span className={error ? "status status-error" : "status"}>
          {error ?? loadedFont?.fileName ?? "폰트 미선택 — 시스템 폰트로 표시 중"}
        </span>
      </header>

      <div
        className="preview"
        contentEditable
        spellCheck={false}
        suppressContentEditableWarning
        style={{ fontFamily: loadedFont ? `"${loadedFont.family}"` : undefined }}
      >
        {SAMPLE_TEXT}
      </div>
    </main>
  );
}

export default App;
