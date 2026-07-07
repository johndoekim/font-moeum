import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  const [merged, setMerged] = useState<LoadedFont | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(32);
  const [lineHeight, setLineHeight] = useState(1.5);
  // 슬롯별로 이전 face를 지우고, 패밀리 이름에 시퀀스를 붙여 캐시 충돌 방지.
  const facesRef = useRef<Record<SlotId, FontFace | null>>({ a: null, b: null });
  const mergedFaceRef = useRef<FontFace | null>(null);
  const faceSeqRef = useRef(0);

  function clearMerged() {
    if (mergedFaceRef.current) {
      document.fonts.delete(mergedFaceRef.current);
      mergedFaceRef.current = null;
    }
    setMerged(null);
    setMergeError(null);
  }

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
      // 슬롯이 바뀌면 기존 병합 결과는 무효
      clearMerged();
      // 병합용으로 Rust에 바이트 업로드 (웹뷰는 파일 경로를 모르므로)
      await invoke("upload_font", new Uint8Array(buffer), { headers: { slot } });
    } catch (e) {
      setErrors((prev) => ({ ...prev, [slot]: `로드 실패: ${String(e)}` }));
    }
  }

  async function mergeFonts() {
    setMerging(true);
    setMergeError(null);
    try {
      const data = await invoke<ArrayBuffer>("merge_fonts", {
        name: "MoaMerged",
        base: "A",
      });
      const family = `merged-${++faceSeqRef.current}`;
      const face = new FontFace(family, data);
      await face.load();
      if (mergedFaceRef.current) document.fonts.delete(mergedFaceRef.current);
      document.fonts.add(face);
      mergedFaceRef.current = face;
      setMerged({ family, fileName: "MoaMerged" });
    } catch (e) {
      setMergeError(String(e));
    } finally {
      setMerging(false);
    }
  }

  // A → B 순서의 CSS 폴백 스택: 병합 전 근사 미리보기.
  const familyStack = [fonts.a, fonts.b]
    .filter((f): f is LoadedFont => f !== null)
    .map((f) => `"${f.family}"`)
    .join(", ");
  // 병합 결과가 있으면 그것만 사용 — 진짜 병합 폰트의 미리보기.
  const previewFamily = merged ? `"${merged.family}"` : familyStack || undefined;

  const canMerge = fonts.a !== null && fonts.b !== null && !merging;
  const statusText = mergeError
    ? mergeError
    : merging
      ? "병합 중… 첫 병합은 몇 초 걸립니다"
      : merged
        ? "병합 폰트 미리보기 중 (실제 병합 결과)"
        : fonts.a && fonts.b
          ? "A 라틴 + B 한글 조합 미리보기 중 (CSS 폴백 근사)"
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
        <button className="merge-button" disabled={!canMerge} onClick={mergeFonts}>
          {merging && <span className="spinner" />}
          {merging ? "병합 중…" : "병합"}
        </button>
        <span className={mergeError ? "status status-error" : "status"}>{statusText}</span>
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
          fontFamily: previewFamily,
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
