import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { DEFAULT_SAMPLE, FONT_SAMPLES, FontSample } from "./samples";
import type { LoadedFont, MergedEntry, SlotId, MergeMode, Style, BasicOpts, MonoOpts } from "./types";
import { SLOT_INFO, BASIC_DEFAULTS, MONO_DEFAULTS, DEFAULT_NAMES, STYLES, UPEM_MIN, UPEM_MAX } from "./types";
import { readFamilyName, readUnitsPerEm } from "./fontUtils";
import { deriveDefaultName } from "./outputName";
import { buildStatus } from "./status";
import { tokenizeLine, LANG_NAME } from "./syntax";
import { FontSlot } from "./FontSlot";
import { SidebarSection } from "./SidebarSection";
import { useCursorTracking } from "./useCursorTracking";
import { StatusBar } from "./StatusBar";
import "./App.css";

// 헤더 버전 배지 — package.json/tauri.conf의 실제 버전과 맞춘 상수(외부 JSON import 회피).
const APP_VERSION = "0.1.0";

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
  // unitsPerEm 입력의 "날 텍스트" — basicOpts.upem(검증된 모델값)과 분리해야 타이핑이 막히지 않는다.
  // (컨트롤드 인풋을 매 키 입력마다 범위검증→null로 되돌리면 16 미만 중간값이 지워져 입력 불가)
  const [upemText, setUpemText] = useState(BASIC_DEFAULTS.upem == null ? "" : String(BASIC_DEFAULTS.upem));
  const [monoOpts, setMonoOpts] = useState<MonoOpts>(MONO_DEFAULTS);
  // 사이드바 섹션 접힘 상태 — 순수 UI(값은 App이 소유하므로 접어도 컨트롤 값·자동 재병합 불변).
  // 전부 기본 펼침: 출력을 접으면 병합/저장 버튼이 사라지므로 첫 화면은 열어둔다.
  const [open, setOpen] = useState({ slots: true, options: true, preview: true, output: true });
  const toggleSection = (k: keyof typeof open) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  // 옵션을 바꾸면 자동으로 다시 병합할지 — 이 툴의 재조정 루프. 끄면 병합 버튼으로 수동 적용.
  const [autoMerge, setAutoMerge] = useState(true);
  const [stats, setStats] = useState<unknown>(null); // 현재 미리보기 병합의 사이드카 통계
  // 현재 미리보기 중인 병합이 실제로 어느 모드로 만들어졌는지 — get_merge_stats가 실패해
  // stats가 null이어도 이 값은 mergeFonts 호출 시점의 mode를 그대로 담아 항상 신뢰 가능하다.
  const [mergedMode, setMergedMode] = useState<MergeMode | null>(null);
  const [sample, setSample] = useState<FontSample>(DEFAULT_SAMPLE);
  const [fontSize, setFontSize] = useState(16);
  const [lineHeight, setLineHeight] = useState(1.6);
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
  // 마지막으로 자동 채운 출력 이름 — 입력칸이 자동값 그대로인지(=사용자 미편집) 판정용.
  const lastAutoNameRef = useRef(DEFAULT_NAMES.basic);
  // 직전에 계산된 파생 이름 — 값이 안 바뀌었으면 effect가 필드를 아예 안 건드리게 하는 가드용.
  const lastDerivedRef = useRef(DEFAULT_NAMES.basic);

  // 일시적 안내 — 몇 초 뒤 사라지고 기본 상태 표시(라틴 우선 폰트 등)로 돌아간다
  function flashNotice(msg: string) {
    setNotice(msg);
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 5000);
  }

  // 커서 추적 + active-line 하이라이트(crown A)는 previewRef를 넘겨 훅으로 위임.
  const { cursor, resetCursor } = useCursorTracking(previewRef);

  function clearMerged() {
    // 캐시가 face를 소유하므로 여기서 document.fonts에서 지우지 않는다
    setMerged(null);
    setMergeError(null);
    setNotice(null);
    setStats(null);
    setMergedMode(null);
  }

  async function loadFontFile(slot: SlotId, file: File) {
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith(".ttf") && !lowerName.endsWith(".otf")) {
      setErrors((prev) => ({ ...prev, [slot]: "TTF/OTF 파일만 지원합니다" }));
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
      const upem = readUnitsPerEm(buffer);
      // name 테이블 패밀리 이름(없으면 파일명 stem) — 기본 출력 이름 생성용.
      const familyName = readFamilyName(buffer) ?? file.name.replace(/\.[^.]+$/, "");
      setFonts((prevFonts) => ({ ...prevFonts, [slot]: { family, fileName: file.name, upem, familyName } }));
      setErrors((prevErrors) => ({ ...prevErrors, [slot]: null }));
      clearMerged();
      // 병합용으로 Rust에 바이트 업로드 (웹뷰는 파일 경로를 모르므로)
      await invoke("upload_font", new Uint8Array(buffer), { headers: { slot } });
      // 고정폭·OTF 변환 판정 — mono 엔진 check_monospace와 같은 코드(사이드카 inspect)라
      // 배지와 병합 검증이 어긋나지 않는다. 전송 실패·미응답은 무시(배지 없음).
      // ok:false(가변 OTF(CFF2) 등)는 슬롯 에러로 표면화 — FontFace는 CFF2도 잘 렌더링해
      // 브라우저가 못 걸러주므로, 첫 병합이 아니라 업로드 시점에 알려야 한다.
      // 슬롯은 face 역탐색으로 정한다: 응답 대기 중 스왑되면 face가 반대 슬롯으로
      // 이동하므로, 업로드 시점 슬롯이 아니라 지금 face가 있는 슬롯에 적용해야
      // 판정이 유실되지 않는다(OTF 변환 inspect는 수 초 — 그 사이 스왑 가능).
      // face가 어느 슬롯에도 없으면(새 파일로 교체) 폐기. 한계: 스왑이 Rust의
      // 경로 확정보다 먼저 끝나는 ms급 창에서는 반대 폰트의 판정이 붙을 수 있으나
      // 배지/에러 표시 한정이고 재업로드로 복구된다.
      void invoke<{ ok?: boolean; error?: string; monospace?: boolean; converted_from_otf?: boolean }>(
        "inspect_font",
        { slot },
      )
        .then((r) => {
          const slotNow = (["a", "b"] as const).find((s) => facesRef.current[s] === face);
          if (!slotNow) return;
          if (r?.ok === false && typeof r?.error === "string") {
            // 백엔드가 거부한 폰트는 미리보기·병합 경로에서도 내린다 — 에러 타일인데
            // 미리보기는 그 폰트로 렌더링되고 병합 버튼이 살아 있는 반쪽 상태 방지.
            // 에러 메시지의 내부 임시 파일명(upload_N.ttf)은 사용자 파일명으로 치환.
            document.fonts.delete(face);
            facesRef.current[slotNow] = null;
            setFonts((prev) => ({ ...prev, [slotNow]: null }));
            const msg = r.error.replace(/^upload_\d+\.ttf:\s*/, "");
            setErrors((prev) => ({ ...prev, [slotNow]: `${file.name}: ${msg}` }));
            return;
          }
          if (typeof r?.monospace !== "boolean") return;
          setFonts((prev) =>
            prev[slotNow]?.family === family
              ? {
                  ...prev,
                  [slotNow]: {
                    ...prev[slotNow],
                    monospace: r.monospace,
                    convertedFromOtf: r.converted_from_otf === true,
                  },
                }
              : prev,
          );
        })
        .catch(() => {});
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
      setErrors((prev) => ({ ...prev, [slot]: `로드 실패 — 파일이 손상됐거나 유효한 폰트가 아닙니다 (${String(e)})` }));
    }
  }

  // 사이드카가 기대하는 snake_case 옵션 객체 — 모드별로 고정된 키 집합·삽입 순서라
  // JSON.stringify가 결정적이다(캐시 키의 결정성 근거). 예약 키(cmd/font_a/...)는 Rust가 얹는다.
  function buildOptions(): Record<string, unknown> {
    const name = outName.trim() || DEFAULT_NAMES[mode];
    if (mode === "basic")
      return { mode, name, style, base: basicOpts.base, cjk_source: basicOpts.cjk, upem: basicOpts.upem };
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

  // 캐시 키 = 슬롯 업로드 번호 + 옵션 전체(mode 포함, name 포함). 옵션이 바뀌면 키가 바뀌고,
  // 모드 무관 필드(basic일 때 mono 슬라이더)는 buildOptions 출력에 애초에 없어 키에 안 걸린다.
  // name도 키에 남겨둔다 — 이름을 바꾸고 병합하면 그 이름이 실제로 반영돼야 하므로.
  function mergeKey(): string {
    return `${slotSeqRef.current.a}|${slotSeqRef.current.b}|${JSON.stringify(buildOptions())}`;
  }

  // 자동 재병합 "트리거" 직렬화 — buildOptions()에서 name만 뺀 것. name은 글리프/외형에
  // 영향이 없으므로(name 테이블만 바뀜) 이름만 편집할 때는 자동 재병합을 유발하지 않는다.
  // style은 fsSelection/macStyle 비트 + name 테이블 둘 다에 영향을 주므로 트리거에 남긴다.
  // 캐시 키·실제 병합 payload(buildOptions)에는 여전히 name이 그대로 쓰여, 수동 병합이나
  // 다른 옵션 변경으로 트리거가 재발화될 때 최신 이름이 반영된다.
  function buildRemergeTrigger(): Record<string, unknown> {
    const { name, ...rest } = buildOptions();
    return rest;
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
        setMerged({ family: cached.family, fileName: name, upem: null }); // 병합 결과는 소스 upem 개념 없음
        setStats(cached.stats);
        setMergedMode(mode);
        lastMergedKeyRef.current = key;
        flashNotice("같은 조합·옵션으로 이미 병합됨 — 이전 결과를 바로 표시");
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
      setMerged({ family, fileName: name, upem: null }); // 병합 결과는 소스 upem 개념 없음
      setStats(stats);
      setMergedMode(mode);
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

  // 모드 전환 — 이름 자동 반영은 아래 effect가 담당(mode가 의존성). 여기선 모드만 바꾼다.
  function switchMode(next: MergeMode) {
    if (next === mode) return;
    setMode(next);
  }

  // 기본 출력 이름 자동 반영 — 폰트 로드·교체·스왑·모드 전환마다 A-B 이름으로 갱신하되,
  // 사용자가 입력칸을 직접 편집했으면(자동값과 달라졌으면) 그 값을 지킨다. 빈칸은 "미편집"으로 간주.
  // outName은 의도적으로 의존성에서 제외 — 사용자 타이핑이 이 effect를 재발화시키지 않게 한다.
  useEffect(() => {
    const next = deriveDefaultName(fonts, mode);
    // 파생 이름이 직전과 같으면 필드를 아예 건드리지 않는다 — OTF inspect가 수 초 뒤 setFonts를
    // 다시 쏘아 이 effect가 재발화해도(같은 familyName → 같은 next), 그 사이 사용자가 비워 둔
    // 입력칸을 도로 채우지 않게 하고 불필요한 재렌더도 없앤다. lastAutoNameRef가 아니라 별도
    // lastDerivedRef로 판정 — 사용자가 편집해 채움을 건너뛴 경우에도 파생값 추적이 이어진다.
    if (next === lastDerivedRef.current) return;
    lastDerivedRef.current = next;
    if (outName === lastAutoNameRef.current || outName.trim() === "") {
      lastAutoNameRef.current = next;
      setOutName(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fonts, mode]);

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
  // dep은 buildRemergeTrigger()(name 제외) — 이름만 바꿔선 이 값이 그대로라 effect가 안 돈다.
  const remergeTriggerSerial = JSON.stringify(buildRemergeTrigger());
  useEffect(() => {
    if (!autoMerge) return; // 자동 재병합 꺼짐 → 병합 버튼으로만 적용
    if (merged === null) return;
    if (mergeKey() === lastMergedKeyRef.current) return; // 방금 병합한 상태 → 재발화 방지
    const timer = window.setTimeout(() => {
      void requestAutoMerge();
    }, 500);
    return () => window.clearTimeout(timer);
    // mergeKey(name 포함)는 실제 병합 시 쓰이고, effect 재발화 여부는 remergeTriggerSerial로만 판정.
    // autoMerge를 켜는 순간 옵션이 스테일이면(키 불일치) 여기서 즉시 재병합이 예약된다.
    // 슬롯 변경은 clearMerged로 merged=null이 되어 여기 안 옴.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merged, remergeTriggerSerial, requestAutoMerge, autoMerge]);

  // 4a. A/B 스왑 — 파일·face·업로드 번호를 통째로 맞바꾸고, 병합돼 있었다면 자동 재병합
  async function swapSlots() {
    // mergingRef는 동기 플래그라 merging(state)보다 정확하다(캐시 복원처럼 merging state가
    // 안 켜지는 경로도 있음). 자동 재병합 스케줄러와 이 플래그를 공유해 스왑↔자동 재병합이
    // 서로 배타적으로 실행되게 한다.
    if (mergingRef.current) return;
    const wasMerged = merged !== null && fonts.a !== null && fonts.b !== null;
    mergingRef.current = true;
    // 스왑 IPC를 기다리기 전에 대기 중인 debounce 재병합 타이머를 미리 재운다
    // (merged→null이 되면 effect cleanup이 타이머를 clear). 이걸 뒤로 미루면 스왑 대기 중
    // 타이머가 만료돼 requestAutoMerge가 병합을 시작하고, 스왑 완료 후 재병합이 겹쳐 실행된다.
    clearMerged();
    try {
      // Rust 쪽 스왑이 성공한 뒤에만 프론트를 뒤집는다 — 실패 시 양쪽 A/B가 어긋나면
      // 이후 병합이 조용히 반대 조합으로 나간다
      await invoke("swap_fonts");
    } catch (e) {
      setMergeError(String(e));
      mergingRef.current = false;
      return;
    }
    setFonts((p) => ({ a: p.b, b: p.a }));
    setErrors((p) => ({ a: p.b, b: p.a }));
    facesRef.current = { a: facesRef.current.b, b: facesRef.current.a };
    slotSeqRef.current = { a: slotSeqRef.current.b, b: slotSeqRef.current.a };
    mergingRef.current = false; // 재병합은 스케줄러를 거치게 하기 위해 여기서 반드시 먼저 해제
    if (wasMerged) await requestAutoMerge();
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
  // 자동 재병합이 꺼진 상태에서 옵션이 바뀌어 현재 미리보기가 옛 병합 결과인 경우 →
  // 병합 버튼을 "다시 병합"으로 바꿔 재병합을 유도한다.
  const stale = merged !== null && !autoMerge && mergeKey() !== lastMergedKeyRef.current;
  // mono 모드에서 스왑하면 한글 폰트가 고정폭 A 자리로 가 check_monospace에 막힌다 —
  // basic 모드에서만 허용.
  const canSwap = !merging && mode === "basic" && (fonts.a !== null || fonts.b !== null);
  const baseFont = basicOpts.base === "A" ? fonts.a : fonts.b;
  const cjkFont = basicOpts.cjk === "A" ? fonts.a : fonts.b;
  // basic 모드 unitsPerEm 표시용: 각 폰트 실제 upem과 자동값(= A·B 중 큰 값, Python 규칙과 동일).
  const upemA = fonts.a?.upem ?? null;
  const upemB = fonts.b?.upem ?? null;
  const resolvedUpem = Math.max(upemA ?? 0, upemB ?? 0) || null;
  const { text: statusText, className: statusClass, dot: statusDot } = buildStatus({
    mergeError,
    merging,
    mode,
    notice,
    merged,
    mergedMode,
    stats,
    baseFont,
    basicOptsBase: basicOpts.base,
    cjkFont,
    basicOptsCjk: basicOpts.cjk,
    fontsA: fonts.a,
    fontsB: fonts.b,
  });

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span>FONT MOEUM</span>
          <span className="app-version">v{APP_VERSION}</span>
        </div>

        <SidebarSection
          title="폰트 슬롯"
          open={open.slots}
          onToggle={() => toggleSection("slots")}
          actions={
            <button
              type="button"
              className="swap-icon"
              disabled={!canSwap}
              onClick={swapSlots}
              aria-label="A/B 스왑"
              title={
                mode === "mono"
                  ? "코딩 폰트 모드에선 A는 고정폭 영문 전용 — 스왑 불가"
                  : "A·B를 맞바꿈 — 겹치는 라틴을 가질 폰트도 반대로"
              }
            >
              ⇅
            </button>
          }
        >
          <FontSlot
            slot="a"
            info={SLOT_INFO[mode].a}
            font={fonts.a}
            error={errors.a}
            onFile={(file) => loadFontFile("a", file)}
          />
          <FontSlot
            slot="b"
            info={SLOT_INFO[mode].b}
            font={fonts.b}
            error={errors.b}
            onFile={(file) => loadFontFile("b", file)}
          />
        </SidebarSection>

        <SidebarSection
          title="병합 옵션"
          open={open.options}
          onToggle={() => toggleSection("options")}
        >
          <div className="segmented seg-mode">
            <button
              type="button"
              className={mode === "basic" ? "seg-active" : ""}
              onClick={() => switchMode("basic")}
              title="한글이 자기 비율대로 들어감 — 문서·UI용 (A·B 전체 합침)"
            >
              일반
            </button>
            <button
              type="button"
              className={mode === "mono" ? "seg-active" : ""}
              onClick={() => switchMode("mono")}
              title={
                fonts.a?.monospace === false
                  ? "한글이 라틴 2칸 격자에 맞춰 들어감 — 터미널·에디터용 (현재 A가 고정폭이 아니라 병합이 거부됩니다)"
                  : "한글이 라틴 2칸 격자에 맞춰 들어감 — 터미널·에디터용 (A는 고정폭 영문)"
              }
            >
              코딩 폰트
            </button>
          </div>
          {mode === "basic" && fonts.a?.monospace === true && (
            <div className="mode-hint">A가 고정폭 — 코딩 폰트 모드 추천</div>
          )}
          {mode === "basic" ? (
            <>
              <div className="control">
                <span title="겹치는 라틴·숫자·문장부호를 가질 폰트">라틴 담당</span>
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
              <div className="control">
                <span title="겹치는 한글·한자·전각(CJK)을 가질 폰트">CJK 담당</span>
                <div className="segmented">
                  {(["A", "B"] as const).map((c) => (
                    <button
                      key={c}
                      className={basicOpts.cjk === c ? "seg-active" : ""}
                      onClick={() => setBasicOpts((o) => ({ ...o, cjk: c }))}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <label className="control">
                <span title="폰트 좌표 해상도 — 1em을 몇 단위로 나누는지. 비우면 A·B 중 큰 값으로 자동.">
                  unitsPerEm
                </span>
                <span className="control-hint">
                  {`A ${upemA ?? "—"} · B ${upemB ?? "—"}`}
                </span>
                <input
                  className="name-input"
                  type="number"
                  spellCheck={false}
                  placeholder={resolvedUpem ? `자동 · ${resolvedUpem}` : "자동 · A·B 중 큰 값"}
                  value={upemText}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setUpemText(v); // 텍스트는 그대로 보존 → 타이핑 중 지워지지 않음
                    const n = Number(v.trim());
                    // 빈칸·비숫자·범위 밖은 병합에선 자동(null)로 폴백. 단 입력칸 텍스트는 유지.
                    const valid = v.trim() !== "" && Number.isFinite(n) && n >= UPEM_MIN && n <= UPEM_MAX;
                    setBasicOpts((o) => ({ ...o, upem: valid ? n : null }));
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
                  onChange={(e) => {
                    // 이벤트 값은 반드시 업데이터 밖에서 읽는다 — React가 핸들러 종료 후
                    // e.currentTarget을 null로 회수하므로 업데이터 안에서 읽으면 크래시.
                    const v = Number(e.currentTarget.value);
                    setMonoOpts((o) => ({ ...o, koreanScale: v }));
                  }}
                />
              </label>
              <label className="control">
                <span>폭 배수</span>
                <select
                  className="select-input"
                  value={monoOpts.widthMult}
                  onChange={(e) => {
                    const v = Number(e.currentTarget.value);
                    setMonoOpts((o) => ({ ...o, widthMult: v }));
                  }}
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
                  onChange={(e) => {
                    const v = Number(e.currentTarget.value);
                    setMonoOpts((o) => ({ ...o, ty: v }));
                  }}
                />
              </label>
              <label className="check-row" title="한자(U+4E00–9FFF) 복사 — 끄면 파일이 작아짐">
                <input
                  type="checkbox"
                  checked={monoOpts.includeHanja}
                  onChange={(e) => {
                    const checked = e.currentTarget.checked;
                    setMonoOpts((o) => ({ ...o, includeHanja: checked }));
                  }}
                />
                <span>한자 포함</span>
              </label>
              <div className="control">
                <span title="전각·CJK 구두점(U+3000–303F·FF00–FFEF)을 가질 폰트">전각 담당</span>
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
                  onChange={(e) => {
                    const checked = e.currentTarget.checked;
                    setMonoOpts((o) => ({ ...o, jamoCcmp: checked }));
                  }}
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
        </SidebarSection>

        <SidebarSection
          title="미리보기"
          open={open.preview}
          onToggle={() => toggleSection("preview")}
        >
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
        </SidebarSection>

        <SidebarSection
          title="출력"
          open={open.output}
          onToggle={() => toggleSection("output")}
        >
          <input
            className="name-input"
            value={outName}
            spellCheck={false}
            placeholder={DEFAULT_NAMES[mode]}
            onChange={(e) => setOutName(e.currentTarget.value)}
            title="출력 폰트 패밀리 이름"
          />
          <div className="control">
            <select
              className="select-input"
              value={style}
              onChange={(e) => setStyle(e.currentTarget.value as Style)}
              title="출력 폰트의 스타일 라벨(name·OS/2·head 비트)만 설정 — 실제 글리프의 굵기·기울기는 그대로. 진짜 볼드·이탤릭은 해당 굵기의 A·B 원본을 로드하세요."
            >
              {STYLES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className="control-hint">이름·OS/2 라벨 전용 · 미리보기엔 영향 없음</span>
          </div>
          <label
            className="check-row"
            title="옵션(스케일·오프셋 등)을 바꾸면 0.5초 뒤 자동으로 다시 병합해 미리보기에 반영. 끄면 병합 버튼으로 수동 적용."
          >
            <input
              type="checkbox"
              checked={autoMerge}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setAutoMerge(checked);
              }}
            />
            <span>옵션 바꾸면 자동 재병합</span>
          </label>
          <button
            className={stale ? "merge-button merge-button-stale" : "merge-button"}
            disabled={!canMerge}
            onClick={() => void requestAutoMerge()}
          >
            {merging && <span className="spinner" />}
            {merging ? "병합 중…" : stale ? "다시 병합" : "병합"}
          </button>
          <button
            className="export-button"
            disabled={!merged || merging}
            onClick={exportMerged}
          >
            TTF로 저장…
          </button>
        </SidebarSection>
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
                resetCursor();
              }}
            >
              {s.id === sample.id && (
                <span className={merged ? "tab-dot tab-dot-merged" : "tab-dot"} />
              )}
              {s.filename}
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

        <StatusBar
          statusText={statusText}
          statusClass={statusClass}
          dot={statusDot}
          cursor={cursor}
          fontSize={fontSize}
          lineHeight={lineHeight}
          langLabel={LANG_NAME[sample.lang] ?? sample.lang}
        />
      </section>
    </main>
  );
}

export default App;
