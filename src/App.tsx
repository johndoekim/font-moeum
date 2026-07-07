import { useRef, useState } from "react";
import "./App.css";

const SAMPLE_TEXT = "안녕하세요 Hello 123 반갑습니다 Typography";

interface LoadedFont {
  family: string;
  fileName: string;
}

type SlotId = "a" | "b";

const SLOT_INFO: Record<SlotId, { title: string; desc: string }> = {
  a: { title: "A · 영문 폰트", desc: "라틴 · 숫자 · 문장부호 우선" },
  b: { title: "B · 한글 폰트", desc: "한글 글리프 담당" },
};

function FontSlot({
  info,
  font,
  error,
  onFile,
}: {
  info: { title: string; desc: string };
  font: LoadedFont | null;
  error: string | null;
  onFile: (file: File) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className={
        "slot" +
        (dragOver ? " slot-dragover" : "") +
        (error ? " slot-error" : "") +
        (font ? " slot-loaded" : "")
      }
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
    >
      <div className="slot-title">{info.title}</div>
      <div className="slot-file">
        {error ?? font?.fileName ?? "TTF를 드래그하거나 클릭해서 선택"}
      </div>
      <div className="slot-desc">{info.desc}</div>
      <input
        ref={inputRef}
        type="file"
        accept=".ttf"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) onFile(file);
        }}
      />
    </div>
  );
}

function App() {
  const [fonts, setFonts] = useState<Record<SlotId, LoadedFont | null>>({
    a: null,
    b: null,
  });
  const [errors, setErrors] = useState<Record<SlotId, string | null>>({
    a: null,
    b: null,
  });
  const [fontSize, setFontSize] = useState(32);
  const [lineHeight, setLineHeight] = useState(1.5);
  // 슬롯별로 이전 face를 지우고, 패밀리 이름에 시퀀스를 붙여 캐시 충돌 방지.
  const facesRef = useRef<Record<SlotId, FontFace | null>>({ a: null, b: null });
  const faceSeqRef = useRef(0);

  async function loadFontFile(slot: SlotId, file: File) {
    if (!file.name.toLowerCase().endsWith(".ttf")) {
      setErrors((prev) => ({ ...prev, [slot]: "TTF 파일만 지원합니다" }));
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const family = `slot-${slot}-${++faceSeqRef.current}`;
      const face = new FontFace(family, buffer);
      await face.load();
      const prev = facesRef.current[slot];
      if (prev) document.fonts.delete(prev);
      document.fonts.add(face);
      facesRef.current[slot] = face;
      setFonts((prevFonts) => ({ ...prevFonts, [slot]: { family, fileName: file.name } }));
      setErrors((prevErrors) => ({ ...prevErrors, [slot]: null }));
    } catch {
      setErrors((prev) => ({ ...prev, [slot]: `로드 실패: ${file.name}` }));
    }
  }

  // A → B 순서의 CSS 폴백 스택: 라틴은 A가 이기고, A에 없는 한글은 B가 받는다.
  // 실제 병합(Phase 2~3) 전까지 병합 결과를 근사하는 미리보기.
  const familyStack = [fonts.a, fonts.b]
    .filter((f): f is LoadedFont => f !== null)
    .map((f) => `"${f.family}"`)
    .join(", ");

  const statusText =
    fonts.a && fonts.b
      ? "A 라틴 + B 한글 조합 미리보기 중 (CSS 폴백)"
      : fonts.a || fonts.b
        ? "폰트 1개 적용 중 — 나머지 슬롯도 채워보세요"
        : "A(영문)·B(한글) TTF를 올리면 함께 미리보기됩니다";

  return (
    <main className="app">
      <header className="toolbar">
        <label className="slider">
          <span className="slider-label">크기 {fontSize}px</span>
          <input
            type="range"
            min={12}
            max={120}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.currentTarget.value))}
          />
        </label>
        <label className="slider">
          <span className="slider-label">줄높이 {lineHeight.toFixed(2)}</span>
          <input
            type="range"
            min={1}
            max={2.5}
            step={0.05}
            value={lineHeight}
            onChange={(e) => setLineHeight(Number(e.currentTarget.value))}
          />
        </label>
        <span className="status">{statusText}</span>
      </header>

      <section className="slots">
        {(["a", "b"] as const).map((slot) => (
          <FontSlot
            key={slot}
            info={SLOT_INFO[slot]}
            font={fonts[slot]}
            error={errors[slot]}
            onFile={(file) => loadFontFile(slot, file)}
          />
        ))}
      </section>

      <div
        className="preview"
        contentEditable
        spellCheck={false}
        suppressContentEditableWarning
        style={{
          fontFamily: familyStack || undefined,
          fontSize: `${fontSize}px`,
          lineHeight,
        }}
      >
        {SAMPLE_TEXT}
      </div>
    </main>
  );
}

export default App;
