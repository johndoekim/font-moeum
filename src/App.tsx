import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SAMPLE, FONT_SAMPLES, FontSample } from "./samples";
import "./App.css";

// ── 원샷 신택스 하이라이터 ──────────────────────────────────────
// 초기 렌더에만 적용되는 가벼운 토크나이저 (Dracula: 주석 파랑, 문자열 노랑,
// 숫자 보라, 키워드/연산자 핑크). 편집을 시작하면 그 줄부터는 점차 평문화되는데,
// 미리보기의 목적은 폰트 감별이므로 의도적으로 여기까지만 한다.

const COMMENT_MARKER: Record<string, string> = {
  rust: "//",
  c: "//",
  javascript: "//",
  haskell: "--",
};

const KEYWORDS: Record<string, Set<string>> = {
  rust: new Set(["fn", "let", "mut", "while", "if", "else", "return"]),
  c: new Set(["float", "long", "return"]),
  javascript: new Set(["const", "return"]),
};

const LANG_NAME: Record<string, string> = {
  rust: "Rust",
  c: "C",
  haskell: "Haskell",
  javascript: "JavaScript",
  text: "Plain Text",
};

const TOKEN_RE = /(["'`])(?:\\.|(?!\1).)*?\1|0x[0-9A-Fa-f]+|\d+(?:\.\d+)?F?|[A-Za-z_$][\w$]*|[=!<>+\-*/&|:%^~?]+/g;

interface Token {
  text: string;
  cls?: string;
}

function tokenizeLine(line: string, lang: string): Token[] {
  const marker = COMMENT_MARKER[lang];
  if (!marker) return [{ text: line }]; // text 등: 하이라이팅 없이 순수 폰트 감별용
  const commentIdx = line.indexOf(marker);
  const code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;

  const tokens: Token[] = [];
  const keywords = KEYWORDS[lang];
  let last = 0;
  for (const m of code.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (start > last) tokens.push({ text: code.slice(last, start) });
    const text = m[0];
    let cls: string | undefined;
    if (/^["'`]/.test(text)) cls = "tok-string";
    else if (/^(0x|\d)/.test(text)) cls = "tok-number";
    else if (/^[A-Za-z_$]/.test(text)) cls = keywords?.has(text) ? "tok-keyword" : undefined;
    else cls = "tok-op";
    tokens.push({ text, cls });
    last = start + text.length;
  }
  if (last < code.length) tokens.push({ text: code.slice(last) });
  if (commentIdx >= 0) tokens.push({ text: line.slice(commentIdx), cls: "tok-comment" });
  return tokens;
}

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
  slot,
  info,
  font,
  error,
  onFile,
}: {
  slot: SlotId;
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
        `slot slot-${slot}` +
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
        {error ?? font?.fileName ?? "TTF 드래그 또는 클릭"}
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
  const [sample, setSample] = useState<FontSample>(DEFAULT_SAMPLE);
  const [fontSize, setFontSize] = useState(16);
  const [lineHeight, setLineHeight] = useState(1.6);
  const [cursor, setCursor] = useState({ ln: 1, col: 1 });
  // 슬롯별로 이전 face를 지우고, 패밀리 이름에 시퀀스를 붙여 캐시 충돌 방지.
  const facesRef = useRef<Record<SlotId, FontFace | null>>({ a: null, b: null });
  const mergedFaceRef = useRef<FontFace | null>(null);
  const faceSeqRef = useRef(0);
  const previewRef = useRef<HTMLDivElement>(null);

  // 커서 위치(Ln/Col) 추적 + 현재 줄 하이라이트 — contentEditable은 React가
  // 자식을 다시 그리면 편집 내용이 깨지므로 클래스는 DOM에 직접 토글한다.
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
  }, []);

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
      <aside className="sidebar">
        <div className="sidebar-header">FONT MOA</div>

        <div className="section-label">폰트 슬롯</div>
        {(["a", "b"] as const).map((slot) => (
          <FontSlot
            key={slot}
            slot={slot}
            info={SLOT_INFO[slot]}
            font={fonts[slot]}
            error={errors[slot]}
            onFile={(file) => loadFontFile(slot, file)}
          />
        ))}

        <div className="section-label">미리보기 설정</div>
        <label className="control">
          <span>
            크기 <b>{fontSize}px</b>
          </span>
          <input
            type="range"
            min={12}
            max={120}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.currentTarget.value))}
          />
        </label>
        <label className="control">
          <span>
            줄높이 <b>{lineHeight.toFixed(2)}</b>
          </span>
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
      </aside>

      <section className="main">
        <div className="tabbar">
          {FONT_SAMPLES.map((s) => (
            <div
              key={s.id}
              className={s.id === sample.id ? "tab tab-active" : "tab"}
              title={s.label}
              onClick={() => {
                setSample(s);
                setCursor({ ln: 1, col: 1 });
              }}
            >
              {s.id === sample.id && (
                <span className={merged ? "tab-dot tab-dot-merged" : "tab-dot"} />
              )}
              {s.label.replace(/\s*\(.*\)$/, "")}
            </div>
          ))}
        </div>

        <div className="editor">
          <div
            key={sample.id} /* 샘플 전환 = 파일 다시 열기 (편집 내용 리셋) */
            ref={previewRef}
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
            {sample.code.split("\n").map((line, i) => (
              <div key={i}>
                {line === "" ? (
                  <br />
                ) : (
                  tokenizeLine(line, sample.lang).map((tok, j) =>
                    tok.cls ? (
                      <span key={j} className={tok.cls}>
                        {tok.text}
                      </span>
                    ) : (
                      tok.text
                    ),
                  )
                )}
              </div>
            ))}
          </div>
        </div>

        <footer className="statusbar">
          <span className={mergeError ? "sb-item sb-error" : merged ? "sb-item sb-ok" : "sb-item"}>
            {statusText}
          </span>
          <span className="sb-right">
            <span className="sb-item">
              Ln {cursor.ln}, Col {cursor.col}
            </span>
            <span className="sb-item">
              {fontSize}px · {lineHeight.toFixed(2)}
            </span>
            <span className="sb-item">UTF-8</span>
            <span className="sb-item">{LANG_NAME[sample.lang] ?? sample.lang}</span>
          </span>
        </footer>
      </section>
    </main>
  );
}

export default App;
