import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
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

/** 병합 결과 캐시 항목 — 같은 (A업로드, B업로드, 옵션) 조합은 재병합 없이 복원.
 *  stats는 사이드카가 돌려준 통계(mono)/{mode:"basic"} — 캐시 복원 시 상태바에 재사용. */
interface MergedEntry {
  seqA: number;
  seqB: number;
  family: string;
  face: FontFace;
  bytes: ArrayBuffer;
  stats: unknown;
}

type SlotId = "a" | "b";

// 병합 규칙은 언어가 아니라 "우선순위 + 커버리지": 겹치는 글리프는 A가 이기고,
// B는 A에 없는 나머지 전부를 채운다. 영문→A, 한글→B는 대표 사용례일 뿐.
const SLOT_INFO: Record<SlotId, { title: string; desc: string }> = {
  a: { title: "A · 우선 폰트", desc: "겹치는 글리프는 A가 이김 · 보통 영문" },
  b: { title: "B · 보충 폰트", desc: "A에 없는 글리프 전부 담당 · 보통 한글" },
};

type MergeMode = "basic" | "mono";
type Style = "Regular" | "Bold" | "Italic" | "Bold Italic";

/** 일반 병합(basic): fontTools Merger로 A·B를 합치고 라틴을 base가 이긴다. */
interface BasicOpts {
  base: "A" | "B";
  upem: number | null; // null = 자동(더 큰 UPM)
}
/** 코딩 폰트(mono): 고정폭 A에 한글 B를 셀에 맞춰 스케일·복사. */
interface MonoOpts {
  koreanScale: number; // 0.80–1.40
  widthMult: number; // 2.0 | 1.5
  ty: number; // −0.10–0.10 (em)
  includeHanja: boolean;
  fullwidth: "A" | "B";
  jamoCcmp: boolean;
}

const BASIC_DEFAULTS: BasicOpts = { base: "A", upem: null };
const MONO_DEFAULTS: MonoOpts = {
  koreanScale: 1.15,
  widthMult: 2.0,
  ty: 0,
  includeHanja: true,
  fullwidth: "B",
  jamoCcmp: true,
};
const DEFAULT_NAMES: Record<MergeMode, string> = { basic: "MoeumMerged", mono: "MoeumMono" };
const STYLES: Style[] = ["Regular", "Bold", "Italic", "Bold Italic"];

/** stats(unknown)에서 숫자만 안전하게 꺼낸다 (문자열·undefined·null → 0) */
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

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
  const [notice, setNotice] = useState<string | null>(null);
  const [outName, setOutName] = useState(DEFAULT_NAMES.basic);
  const [mode, setMode] = useState<MergeMode>("basic");
  const [style, setStyle] = useState<Style>("Regular");
  // 모드별 옵션을 분리 보존 — 모드를 오가도 각자 값이 남는다.
  const [basicOpts, setBasicOpts] = useState<BasicOpts>(BASIC_DEFAULTS);
  const [monoOpts, setMonoOpts] = useState<MonoOpts>(MONO_DEFAULTS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [stats, setStats] = useState<unknown>(null); // 현재 미리보기 병합의 사이드카 통계
  const [sample, setSample] = useState<FontSample>(DEFAULT_SAMPLE);
  const [fontSize, setFontSize] = useState(16);
  const [lineHeight, setLineHeight] = useState(1.6);
  const [cursor, setCursor] = useState({ ln: 1, col: 1 });
  // 슬롯별로 이전 face를 지우고, 패밀리 이름에 시퀀스를 붙여 캐시 충돌 방지.
  const facesRef = useRef<Record<SlotId, FontFace | null>>({ a: null, b: null });
  const faceSeqRef = useRef(0);
  // 캐시 키 재료: 슬롯에 어떤 업로드(고유 번호)가 들어있는지. 스왑하면 번호도 스왑.
  const uploadCounterRef = useRef(0);
  const slotSeqRef = useRef<Record<SlotId, number>>({ a: 0, b: 0 });
  const mergeCacheRef = useRef<Map<string, MergedEntry>>(new Map());
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const previewRef = useRef<HTMLDivElement>(null);
  // debounce 재조정 루프용 refs (state가 아니라 동기 값이라야 코얼레싱이 정확하다)
  const mergingRef = useRef(false); // 병합 in-flight 여부 (동시 병합 금지)
  const rerunRef = useRef(false); // 병합 중 새 변경이 들어왔는가 (trailing 1회)
  const lastMergedKeyRef = useRef<string | null>(null); // 마지막으로 실제 병합한 캐시 키
  // 스케줄러가 항상 "최신" 옵션으로 돌게 하기 위한 최신 함수 스냅샷 (stale closure 방지)
  const mergeFontsRef = useRef<() => Promise<void>>(async () => {});
  const mergeKeyRef = useRef<() => string>(() => "");

  // 일시적 안내 — 몇 초 뒤 사라지고 기본 상태 표시(라틴 우선 폰트 등)로 돌아간다
  function flashNotice(msg: string) {
    setNotice(msg);
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 5000);
  }

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
    // 캐시가 face를 소유하므로 여기서 document.fonts에서 지우지 않는다
    setMerged(null);
    setMergeError(null);
    setNotice(null);
    setStats(null);
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
      clearMerged();
      // 병합용으로 Rust에 바이트 업로드 (웹뷰는 파일 경로를 모르므로)
      await invoke("upload_font", new Uint8Array(buffer), { headers: { slot } });
      // 교체된 업로드를 쓰던 캐시 항목은 무효화 + face 정리
      const replacedSeq = slotSeqRef.current[slot];
      slotSeqRef.current[slot] = ++uploadCounterRef.current;
      for (const [key, entry] of mergeCacheRef.current) {
        if (entry.seqA === replacedSeq || entry.seqB === replacedSeq) {
          document.fonts.delete(entry.face);
          mergeCacheRef.current.delete(key);
        }
      }
    } catch (e) {
      setErrors((prev) => ({ ...prev, [slot]: `로드 실패: ${String(e)}` }));
    }
  }

  // 사이드카가 기대하는 snake_case 옵션 객체 — 모드별로 고정된 키 집합·삽입 순서라
  // JSON.stringify가 결정적이다(캐시 키의 결정성 근거). 예약 키(cmd/font_a/...)는 Rust가 얹는다.
  function buildOptions(): Record<string, unknown> {
    const name = outName.trim() || DEFAULT_NAMES[mode];
    if (mode === "basic")
      return { mode, name, style, base: basicOpts.base, upem: basicOpts.upem };
    return {
      mode,
      name,
      style,
      korean_scale: monoOpts.koreanScale,
      width_mult: monoOpts.widthMult,
      ty: monoOpts.ty,
      include_hanja: monoOpts.includeHanja,
      fullwidth_source: monoOpts.fullwidth,
      jamo_ccmp: monoOpts.jamoCcmp,
    };
  }

  // 캐시 키 = 슬롯 업로드 번호 + 옵션 전체(mode 포함). 옵션이 바뀌면 키가 바뀌고,
  // 모드 무관 필드(basic일 때 mono 슬라이더)는 buildOptions 출력에 애초에 없어 키에 안 걸린다.
  function mergeKey(): string {
    return `${slotSeqRef.current.a}|${slotSeqRef.current.b}|${JSON.stringify(buildOptions())}`;
  }

  async function mergeFonts() {
    const options = buildOptions();
    const name = options.name as string;
    const key = mergeKey();
    setMergeError(null);
    setNotice(null);

    // 4b. 같은 (슬롯·옵션) 조합은 재병합 없이 즉시 복원 (스왑 왕복·옵션 왕복 대응)
    const cached = mergeCacheRef.current.get(key);
    if (cached) {
      try {
        await invoke("set_merged", new Uint8Array(cached.bytes)); // export 대상 동기화
        setMerged({ family: cached.family, fileName: name });
        setStats(cached.stats);
        lastMergedKeyRef.current = key;
        flashNotice("현재 조합·옵션은 이미 병합돼 있어 캐시에서 복원 — 결과 동일, 재계산 생략");
      } catch (e) {
        setMergeError(String(e));
      }
      return;
    }

    setMerging(true);
    try {
      const data = await invoke<ArrayBuffer>("merge_fonts", { options });
      const family = `merged-${++faceSeqRef.current}`;
      const face = new FontFace(family, data);
      await face.load();
      document.fonts.add(face);
      const stats = await invoke<unknown>("get_merge_stats").catch(() => null);
      mergeCacheRef.current.set(key, {
        seqA: slotSeqRef.current.a,
        seqB: slotSeqRef.current.b,
        family,
        face,
        bytes: data,
        stats,
      });
      setMerged({ family, fileName: name });
      setStats(stats);
      lastMergedKeyRef.current = key;
      const warnings = (stats as { warnings?: unknown } | null)?.warnings;
      if (Array.isArray(warnings) && warnings.length)
        flashNotice(`경고: ${warnings.map(String).join(" · ")}`);
    } catch (e) {
      setMergeError(String(e));
    } finally {
      setMerging(false);
    }
  }

  // 모드 전환 — 사용자가 이름을 안 건드렸으면(빈칸/기본이름) 새 모드 기본 이름으로 교체.
  function switchMode(next: MergeMode) {
    if (next === mode) return;
    setOutName((cur) => {
      const t = cur.trim();
      return t === "" || t === DEFAULT_NAMES.basic || t === DEFAULT_NAMES.mono
        ? DEFAULT_NAMES[next]
        : cur;
    });
    setMode(next);
  }

  // 스케줄러가 참조할 "최신" 스냅샷을 매 렌더 갱신 — setTimeout/코얼레싱이 stale 옵션으로
  // 돌지 않게 한다. requestAutoMerge는 useCallback([])이라 이 refs로만 최신값에 닿는다.
  useEffect(() => {
    mergeFontsRef.current = mergeFonts;
    mergeKeyRef.current = mergeKey;
  });

  // 코얼레싱 스케줄러: 동시 병합 금지 + trailing 1회. mergingRef/rerunRef는 동기 ref라
  // React state 지연 없이 정확하다. 수동 버튼도 이 경로를 타 이중 실행이 원천 차단된다.
  const requestAutoMerge = useCallback(async function run(): Promise<void> {
    if (mergingRef.current) {
      rerunRef.current = true; // 병합 중 도착한 변경은 완료 후 딱 1회로 접힌다
      return;
    }
    mergingRef.current = true;
    try {
      await mergeFontsRef.current();
    } finally {
      mergingRef.current = false;
    }
    // 병합 중 새 변경이 있었고, 그 결과가 방금 병합한 키와 다르면 최신 옵션으로 1회 더.
    if (rerunRef.current) {
      rerunRef.current = false;
      if (mergeKeyRef.current() !== lastMergedKeyRef.current) await run();
    }
  }, []);

  // 재조정 루프: 이미 병합 결과가 있을 때(merged !== null)만 옵션 변경이 자동 재병합을 유발.
  // 첫 병합은 수동 버튼. lastMergedKeyRef 갱신으로 effect가 자기 자신을 재발화하지 않는다.
  const optionsSerial = JSON.stringify(buildOptions());
  useEffect(() => {
    if (merged === null) return;
    if (mergeKey() === lastMergedKeyRef.current) return; // 방금 병합한 상태 → 재발화 방지
    const timer = window.setTimeout(() => {
      void requestAutoMerge();
    }, 500);
    return () => window.clearTimeout(timer);
    // mergeKey는 optionsSerial+슬롯seq에서 파생 — 슬롯 변경은 clearMerged로 merged=null이 되어 여기 안 옴
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merged, optionsSerial, requestAutoMerge]);

  // 4a. A/B 스왑 — 파일·face·업로드 번호를 통째로 맞바꾸고, 병합돼 있었다면 자동 재병합
  async function swapSlots() {
    if (merging) return;
    const wasMerged = merged !== null && fonts.a !== null && fonts.b !== null;
    // Rust 쪽 스왑이 성공한 뒤에만 프론트를 뒤집는다 — 실패 시 양쪽 A/B가 어긋나면
    // 이후 병합이 조용히 반대 조합으로 나간다
    try {
      await invoke("swap_fonts");
    } catch (e) {
      setMergeError(String(e));
      return;
    }
    setFonts((p) => ({ a: p.b, b: p.a }));
    setErrors((p) => ({ a: p.b, b: p.a }));
    facesRef.current = { a: facesRef.current.b, b: facesRef.current.a };
    slotSeqRef.current = { a: slotSeqRef.current.b, b: slotSeqRef.current.a };
    clearMerged();
    if (wasMerged) await mergeFonts();
  }

  // 4d. 병합 결과 TTF로 저장
  async function exportMerged() {
    try {
      const base = (merged?.fileName ?? outName).trim() || DEFAULT_NAMES[mode];
      const path = await save({
        defaultPath: `${base}.ttf`,
        filters: [{ name: "TrueType Font", extensions: ["ttf"] }],
      });
      if (!path) return;
      await invoke("export_merged", { path });
      flashNotice(`저장됨: ${path}`);
    } catch (e) {
      setMergeError(String(e));
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
  const canSwap = !merging && (fonts.a !== null || fonts.b !== null);
  // 현재 미리보기 중인 병합의 통계 — stats.mode가 표시의 진실(현재 mode state와 다를 수 있음)
  const st = stats as Record<string, unknown> | null;
  const baseFont = basicOpts.base === "A" ? fonts.a : fonts.b;
  const statusText = mergeError
    ? mergeError
    : merging
      ? mode === "mono"
        ? "코딩 폰트 병합 중… 글리프 스케일·합성"
        : "병합 중… 첫 병합은 몇 초 걸립니다"
      : notice
        ? notice
        : merged
          ? st?.mode === "mono"
            ? `${merged.fileName} · 글리프 ${num(st?.copied)}개 복사` +
              (num(st?.hanja_copied) ? ` (한자 ${num(st?.hanja_copied)})` : "") +
              ` · 자동 축소 ${num(st?.capped)}개` +
              (num(st?.ccmp_rules) ? ` · 자모 ${num(st?.ccmp_rules)}규칙` : "")
            : `병합 미리보기 — ${merged.fileName} · 라틴 우선: ${baseFont?.fileName ?? `${basicOpts.base} 슬롯`}`
          : fonts.a && fonts.b
            ? "A 우선 + B 보충 조합 미리보기 중 (CSS 폴백 근사)"
            : fonts.a || fonts.b
              ? "폰트 1개 적용 중 — 나머지 슬롯도 채워보세요"
              : "우선(A)·보충(B) TTF를 올리면 함께 미리보기됩니다";
  const statusClass = mergeError
    ? "sb-item sb-error"
    : merged || notice
      ? "sb-item sb-ok"
      : "sb-item";

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="sidebar-header">FONT MOEUM</div>

        <div className="section-label">폰트 슬롯</div>
        <FontSlot
          slot="a"
          info={SLOT_INFO.a}
          font={fonts.a}
          error={errors.a}
          onFile={(file) => loadFontFile("a", file)}
        />
        <button
          className="swap-button"
          disabled={!canSwap}
          onClick={swapSlots}
          title="A와 B를 맞바꿔 누가 라틴을 이길지 바꿉니다"
        >
          ⇅ A/B 스왑
        </button>
        <FontSlot
          slot="b"
          info={SLOT_INFO.b}
          font={fonts.b}
          error={errors.b}
          onFile={(file) => loadFontFile("b", file)}
        />

        <div className="section-label">병합 모드</div>
        <div className="segmented">
          <button
            className={mode === "basic" ? "seg-active" : ""}
            onClick={() => switchMode("basic")}
            title="A·B를 그대로 합치고 라틴은 우선 폰트가 이김 — 범용"
          >
            일반 병합
          </button>
          <button
            className={mode === "mono" ? "seg-active" : ""}
            onClick={() => switchMode("mono")}
            title="영문 고정폭 + 한글을 셀에 맞춰 스케일 — 코딩용"
          >
            코딩 폰트
          </button>
        </div>

        <button
          className="advanced-toggle"
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          {advancedOpen ? "▾ 고급 설정" : "▸ 고급 설정"}
        </button>
        {advancedOpen && (
          <div className="advanced-panel">
            {mode === "basic" ? (
              <>
                <div className="control">
                  <span title="겹치는 라틴·숫자·문장부호를 가질 폰트">라틴 우선</span>
                  <div className="segmented">
                    {(["A", "B"] as const).map((b) => (
                      <button
                        key={b}
                        className={basicOpts.base === b ? "seg-active" : ""}
                        onClick={() => setBasicOpts((o) => ({ ...o, base: b }))}
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="control">
                  <span>unitsPerEm</span>
                  <input
                    className="name-input"
                    type="number"
                    spellCheck={false}
                    placeholder="자동(큰 값)"
                    value={basicOpts.upem ?? ""}
                    onChange={(e) => {
                      const v = e.currentTarget.value.trim();
                      setBasicOpts((o) => ({ ...o, upem: v === "" ? null : Number(v) }));
                    }}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="control">
                  <span>
                    한글 스케일 <b>{monoOpts.koreanScale.toFixed(2)}</b>
                  </span>
                  <input
                    type="range"
                    min={0.8}
                    max={1.4}
                    step={0.01}
                    value={monoOpts.koreanScale}
                    onChange={(e) =>
                      setMonoOpts((o) => ({ ...o, koreanScale: Number(e.currentTarget.value) }))
                    }
                  />
                </label>
                <label className="control">
                  <span>폭 배수</span>
                  <select
                    className="select-input"
                    value={monoOpts.widthMult}
                    onChange={(e) =>
                      setMonoOpts((o) => ({ ...o, widthMult: Number(e.currentTarget.value) }))
                    }
                  >
                    <option value={2.0}>2.0 (라틴 2칸)</option>
                    <option value={1.5}>1.5</option>
                  </select>
                </label>
                <label className="control">
                  <span>
                    세로 오프셋{" "}
                    <b>
                      {monoOpts.ty >= 0 ? "+" : ""}
                      {monoOpts.ty.toFixed(2)}em
                    </b>
                  </span>
                  <input
                    type="range"
                    min={-0.1}
                    max={0.1}
                    step={0.01}
                    value={monoOpts.ty}
                    onChange={(e) =>
                      setMonoOpts((o) => ({ ...o, ty: Number(e.currentTarget.value) }))
                    }
                  />
                </label>
                <label className="check-row" title="한자(U+4E00–9FFF) 복사 — 끄면 파일이 작아짐">
                  <input
                    type="checkbox"
                    checked={monoOpts.includeHanja}
                    onChange={(e) =>
                      setMonoOpts((o) => ({ ...o, includeHanja: e.currentTarget.checked }))
                    }
                  />
                  <span>한자 포함</span>
                </label>
                <div className="control">
                  <span title="전각·CJK 구두점(U+3000·FF00–)을 가질 폰트">전각 담당</span>
                  <div className="segmented">
                    {(["A", "B"] as const).map((f) => (
                      <button
                        key={f}
                        className={monoOpts.fullwidth === f ? "seg-active" : ""}
                        onClick={() => setMonoOpts((o) => ({ ...o, fullwidth: f }))}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="check-row" title="조합형 자모를 완성형으로 합성(GSUB ccmp)">
                  <input
                    type="checkbox"
                    checked={monoOpts.jamoCcmp}
                    onChange={(e) =>
                      setMonoOpts((o) => ({ ...o, jamoCcmp: e.currentTarget.checked }))
                    }
                  />
                  <span>자모 조합</span>
                </label>
              </>
            )}
            <button
              className="reset-button"
              onClick={() => (mode === "basic" ? setBasicOpts(BASIC_DEFAULTS) : setMonoOpts(MONO_DEFAULTS))}
            >
              기본값 복원
            </button>
          </div>
        )}

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

        <div className="section-label">출력</div>
        <input
          className="name-input"
          value={outName}
          spellCheck={false}
          placeholder={DEFAULT_NAMES[mode]}
          onChange={(e) => setOutName(e.currentTarget.value)}
          title="출력 폰트 패밀리 이름"
        />
        <select
          className="select-input"
          value={style}
          onChange={(e) => setStyle(e.currentTarget.value as Style)}
          title="출력 폰트 스타일 (name·OS/2 비트에 반영)"
        >
          {STYLES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          className="merge-button"
          disabled={!canMerge}
          onClick={() => void requestAutoMerge()}
        >
          {merging && <span className="spinner" />}
          {merging ? "병합 중…" : "병합"}
        </button>
        <button
          className="export-button"
          disabled={!merged || merging}
          onClick={exportMerged}
        >
          TTF로 저장…
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
          <span className={statusClass}>{statusText}</span>
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
