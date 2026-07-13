# 폰트 메타데이터 기반 기본 출력 이름 자동 생성 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A·B 폰트의 `name` 테이블에서 패밀리 이름을 읽어 `A이름-B이름` 컴팩트 형식으로 기본 출력 이름을 자동 생성하되, 사용자가 직접 편집한 이름은 보존한다.

**Architecture:** 순수 함수 2개(sfnt name 테이블 파서 `readFamilyName`, 조합기 `deriveDefaultName`)를 각각 단독 테스트하고, App.tsx는 이 둘을 wiring만 한다 — 폰트 로드 시 이름을 읽어 `LoadedFont`에 저장하고, effect가 입력칸이 "안 건드려진" 상태일 때만 자동 반영한다. 프론트엔드(JS/TS)만 변경, Python·Rust 무변경.

**Tech Stack:** TypeScript · React 19 · Vitest 4 · pnpm

## Global Constraints

- **이름 형식(컴팩트):** 각 폰트 패밀리 이름의 내부 공백을 모두 제거하고 `-`로 연결. 예: `Departure Mono` + `LXGW WenKai Mono KR` → `DepartureMono-LXGWWenKaiMonoKR`.
- **사용자 입력 절대 보존:** 사용자가 출력 이름 입력칸을 직접 편집했으면 어떤 이벤트(폰트 로드/교체/스왑/모드 전환)에도 자동으로 덮어쓰지 않는다.
- **순수 함수는 React·앱 상태와 무관:** `fontUtils.ts`·`outputName.ts`는 순수 모듈로 단독 테스트 가능. 손상 입력은 방어적으로 `null`/기본값 폴백(기존 `readUnitsPerEm` 스타일).
- **의존성 추가 금지:** 기존 스택(vitest·react·기존 유틸)만 사용. jsdom·RTL 등 컴포넌트 테스트 하네스 도입 안 함.
- **패키지 매니저 pnpm.** 테스트는 `pnpm exec vitest run <파일>`.
- **커밋 메시지 한국어**(레포 관례), 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 트레일러.
- **레코드 선택 우선순위**(nameID·플랫폼): nameID 16(Typographic Family) > nameID 1(Family)을 1차, 같은 nameID 안에서 Windows(platformID 3) > Mac(1) > 기타를 2차로 — 점수 `platScore*10 + idScore`로 spec의 우선순위(16/win, 1/win, 16/mac, 1/mac, 16/기타, 1/기타)를 그대로 구현.

---

### Task 1: sfnt `name` 테이블에서 패밀리 이름 읽기 (`readFamilyName`)

**Files:**
- Modify: `src/fontUtils.ts` (함수 추가 — 기존 `readUnitsPerEm` 아래)
- Test: `src/fontUtils.test.ts` (기존 파일에 describe 블록·헬퍼 추가)

**Interfaces:**
- Produces: `readFamilyName(buffer: ArrayBuffer): string | null` — nameID 16 우선(없으면 1), Windows(UTF-16BE) 우선(없으면 Mac ASCII), 못 읽으면 `null`. Task 3이 소비.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/fontUtils.test.ts` 상단 import에 `readFamilyName`를 추가하고(`import { readFamilyName, readUnitsPerEm } from "./fontUtils";`), 파일 끝에 아래 헬퍼와 describe 블록을 추가한다.

```ts
/** name 레코드 스펙 — platformID 3은 UTF-16BE, 그 외는 ASCII/Latin1로 인코딩. */
interface NameRec {
  platformID: number;
  encodingID: number;
  languageID: number;
  nameID: number;
  text: string;
}

function encodeName(platformID: number, text: string): Uint8Array {
  if (platformID === 3) {
    const out = new Uint8Array(text.length * 2); // UTF-16BE (charCodeAt = UTF-16 코드유닛)
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[i * 2] = (c >> 8) & 0xff;
      out[i * 2 + 1] = c & 0xff;
    }
    return out;
  }
  const out = new Uint8Array(text.length); // ASCII/Latin1
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** numTables=1, 유일한 테이블이 'name'. records를 그대로 name 테이블로 직렬화. */
function makeSfntWithName(records: NameRec[]): ArrayBuffer {
  const encoded = records.map((r) => encodeName(r.platformID, r.text));
  const headerSize = 6; // format(u16) + count(u16) + stringOffset(u16)
  const stringOffset = headerSize + records.length * 12;
  const storageSize = encoded.reduce((s, e) => s + e.length, 0);
  const nameTableSize = stringOffset + storageSize;

  const nameTableOffset = 12 + 16; // sfnt 헤더 + 테이블 레코드 1개
  const buf = new ArrayBuffer(nameTableOffset + nameTableSize);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  dv.setUint32(0, 0x00010000); // sfnt version
  dv.setUint16(4, 1); // numTables
  const tag = "name";
  for (let i = 0; i < 4; i++) dv.setUint8(12 + i, tag.charCodeAt(i));
  dv.setUint32(12 + 8, nameTableOffset); // 테이블 오프셋 (rec+8)
  dv.setUint32(12 + 12, nameTableSize); // 테이블 길이 (rec+12)

  dv.setUint16(nameTableOffset + 0, 0); // format
  dv.setUint16(nameTableOffset + 2, records.length); // count
  dv.setUint16(nameTableOffset + 4, stringOffset); // stringOffset

  let cursor = 0;
  records.forEach((r, i) => {
    const rec = nameTableOffset + headerSize + i * 12;
    dv.setUint16(rec + 0, r.platformID);
    dv.setUint16(rec + 2, r.encodingID);
    dv.setUint16(rec + 4, r.languageID);
    dv.setUint16(rec + 6, r.nameID);
    dv.setUint16(rec + 8, encoded[i].length); // length (bytes)
    dv.setUint16(rec + 10, cursor); // offset (stringOffset 기준)
    u8.set(encoded[i], nameTableOffset + stringOffset + cursor);
    cursor += encoded[i].length;
  });
  return buf;
}

const WIN = { platformID: 3, encodingID: 1, languageID: 0x409 };
const MAC = { platformID: 1, encodingID: 0, languageID: 0 };

describe("readFamilyName", () => {
  it("reads Windows nameID 1 (family) as UTF-16BE", () => {
    const buf = makeSfntWithName([{ ...WIN, nameID: 1, text: "Departure Mono" }]);
    expect(readFamilyName(buf)).toBe("Departure Mono");
  });

  it("prefers nameID 16 (typographic family) over nameID 1", () => {
    const buf = makeSfntWithName([
      { ...WIN, nameID: 1, text: "Legacy Family" },
      { ...WIN, nameID: 16, text: "Preferred Family" },
    ]);
    expect(readFamilyName(buf)).toBe("Preferred Family");
  });

  it("prefers Windows over Mac for the same nameID", () => {
    const buf = makeSfntWithName([
      { ...MAC, nameID: 1, text: "Mac Name" },
      { ...WIN, nameID: 1, text: "Win Name" },
    ]);
    expect(readFamilyName(buf)).toBe("Win Name");
  });

  it("falls back to Mac (ASCII) when no Windows record exists", () => {
    const buf = makeSfntWithName([{ ...MAC, nameID: 1, text: "MacRoman Name" }]);
    expect(readFamilyName(buf)).toBe("MacRoman Name");
  });

  it("trims surrounding whitespace", () => {
    const buf = makeSfntWithName([{ ...WIN, nameID: 1, text: "  Spacey  " }]);
    expect(readFamilyName(buf)).toBe("Spacey");
  });

  it("returns null when there is no name table", () => {
    // 'name'이 아닌 테이블만 있는 sfnt (기존 makeSfnt 재사용)
    expect(readFamilyName(makeSfnt("head", 1000))).toBeNull();
  });

  it("returns null for a corrupt/too-short buffer", () => {
    expect(readFamilyName(new ArrayBuffer(4))).toBeNull();
    expect(readFamilyName(new ArrayBuffer(0))).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm exec vitest run src/fontUtils.test.ts`
Expected: FAIL — `readFamilyName`가 정의되지 않음(import가 `undefined`라 `readFamilyName(...)` 호출이 TypeError).

- [ ] **Step 3: `readFamilyName` 구현**

`src/fontUtils.ts` 끝(기존 `readUnitsPerEm` 아래)에 추가한다.

```ts
/** sfnt 'name' 테이블에서 패밀리 이름을 읽는다. nameID 16(Typographic Family) 우선,
 *  없으면 nameID 1(Family). 플랫폼은 Windows(3, UTF-16BE) 우선 → Mac(1, ASCII) 폴백.
 *  못 읽으면 null(호출부가 파일명으로 폴백). FontFace.load()로 검증된 뒤 호출되므로
 *  정상 sfnt 전제 — 손상/비정상은 null. */
export function readFamilyName(buffer: ArrayBuffer): string | null {
  try {
    const dv = new DataView(buffer);
    const numTables = dv.getUint16(4);
    let nameOffset = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (dv.getUint32(rec) === 0x6e616d65) {
        // 'name'
        nameOffset = dv.getUint32(rec + 8);
        break;
      }
    }
    if (nameOffset < 0) return null;

    const count = dv.getUint16(nameOffset + 2);
    const stringBase = nameOffset + dv.getUint16(nameOffset + 4);

    // 후보를 점수로 골라 가장 좋은 하나만 디코드. 점수 = platScore*10 + idScore →
    // 16/win > 1/win > 16/mac > 1/mac > 16/기타 > 1/기타 (spec 우선순위와 동일).
    let best: { score: number; off: number; len: number; win: boolean } | null = null;
    for (let i = 0; i < count; i++) {
      const rec = nameOffset + 6 + i * 12;
      const platformID = dv.getUint16(rec);
      const nameID = dv.getUint16(rec + 6);
      if (nameID !== 1 && nameID !== 16) continue;
      const len = dv.getUint16(rec + 8);
      const off = dv.getUint16(rec + 10);
      const idScore = nameID === 16 ? 2 : 1;
      const platScore = platformID === 3 ? 2 : platformID === 1 ? 1 : 0;
      const score = platScore * 10 + idScore;
      if (!best || score > best.score) {
        best = { score, off: stringBase + off, len, win: platformID === 3 };
      }
    }
    if (!best) return null;

    const bytes = new Uint8Array(buffer, best.off, best.len);
    let text = "";
    if (best.win) {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]); // UTF-16BE
      }
    } else {
      for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]); // ASCII
    }
    return text.trim() || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm exec vitest run src/fontUtils.test.ts`
Expected: PASS — `readFamilyName` 7개 + 기존 `readUnitsPerEm` 3개 모두 통과.

- [ ] **Step 5: 커밋**

```bash
git add src/fontUtils.ts src/fontUtils.test.ts
git commit -m "$(cat <<'EOF'
sfnt name 테이블 패밀리 이름 파서 추가 (readFamilyName)

nameID 16(Typographic) 우선·1 폴백, Windows(UTF-16BE) 우선·Mac 폴백.
손상 입력은 null. 기존 readUnitsPerEm과 같은 방어적 스타일.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 이름 조합기 (`deriveDefaultName`) + `LoadedFont.familyName` 타입

**Files:**
- Create: `src/outputName.ts`
- Create: `src/outputName.test.ts`
- Modify: `src/types.ts:5-11` (`LoadedFont`에 `familyName?` 추가)

**Interfaces:**
- Consumes: `LoadedFont`(`familyName?: string`), `MergeMode`, `SlotId`, `DEFAULT_NAMES` — 모두 `src/types.ts`.
- Produces: `deriveDefaultName(fonts: Record<SlotId, LoadedFont | null>, mode: MergeMode): string` — 로드된 폰트 familyName을 공백 제거 후 `-`로 join, 없으면 `DEFAULT_NAMES[mode]`. Task 3이 소비.

**Note:** `familyName`은 `?`(옵셔널)로 추가한다 — Task 3에서 `loadFontFile`이 항상 채우기 전까지 기존 `LoadedFont` 리터럴들이 컴파일되게 하기 위함(런타임엔 항상 존재). `deriveDefaultName`은 옵셔널 체이닝으로 부재를 안전 처리한다.

- [ ] **Step 1: `LoadedFont`에 `familyName` 필드 추가**

`src/types.ts`의 `LoadedFont` 인터페이스(5–11행)에 필드 한 줄 추가한다.

```ts
export interface LoadedFont {
  family: string;
  fileName: string;
  upem: number | null; // head.unitsPerEm (파싱 실패 시 null)
  familyName?: string; // name 테이블 패밀리 이름(없으면 파일명 stem) — 기본 출력 이름 생성용
  monospace?: boolean; // 사이드카 inspect 판정 — undefined = 미판정/실패(배지 미표시)
  convertedFromOtf?: boolean; // 사이드카 inspect 판정 — OTF(CFF) 입력, 병합 시 TTF로 변환됨
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/outputName.test.ts` 생성.

```ts
import { describe, it, expect } from "vitest";
import { deriveDefaultName } from "./outputName";
import type { LoadedFont, SlotId } from "./types";

/** familyName만 의미 있는 최소 LoadedFont. */
function font(familyName: string): LoadedFont {
  return { family: "", fileName: "", upem: null, familyName };
}

function slots(a: LoadedFont | null, b: LoadedFont | null): Record<SlotId, LoadedFont | null> {
  return { a, b };
}

describe("deriveDefaultName", () => {
  it("joins A and B family names, stripping inner whitespace, with a hyphen", () => {
    const result = deriveDefaultName(
      slots(font("Departure Mono"), font("LXGW WenKai Mono KR")),
      "basic",
    );
    expect(result).toBe("DepartureMono-LXGWWenKaiMonoKR");
  });

  it("uses only the loaded slot when one side is empty", () => {
    expect(deriveDefaultName(slots(font("Departure Mono"), null), "basic")).toBe("DepartureMono");
    expect(deriveDefaultName(slots(null, font("LXGW WenKai Mono KR")), "basic")).toBe(
      "LXGWWenKaiMonoKR",
    );
  });

  it("falls back to the mode's static default when no fonts are loaded", () => {
    expect(deriveDefaultName(slots(null, null), "basic")).toBe("MoeumMerged");
    expect(deriveDefaultName(slots(null, null), "mono")).toBe("MoeumMono");
  });

  it("ignores a font whose familyName is missing or empty", () => {
    const noName: LoadedFont = { family: "", fileName: "", upem: null };
    expect(deriveDefaultName(slots(noName, font("Nanum Gothic")), "basic")).toBe("NanumGothic");
    expect(deriveDefaultName(slots(noName, null), "mono")).toBe("MoeumMono");
  });
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `pnpm exec vitest run src/outputName.test.ts`
Expected: FAIL — `./outputName` 모듈이 없어 import 해석 실패.

- [ ] **Step 4: `deriveDefaultName` 구현**

`src/outputName.ts` 생성.

```ts
// 기본 출력 이름 조합 — 순수 함수(React·앱 상태 무관, 단독 테스트 가능).
import { DEFAULT_NAMES } from "./types";
import type { LoadedFont, MergeMode, SlotId } from "./types";

/** 로드된 A·B 폰트의 패밀리 이름으로 기본 출력 이름 생성 — 각 이름의 공백을 제거하고 '-'로 연결.
 *  로드된(이름 있는) 폰트가 없으면 모드별 정적 기본값 DEFAULT_NAMES[mode]. */
export function deriveDefaultName(
  fonts: Record<SlotId, LoadedFont | null>,
  mode: MergeMode,
): string {
  const parts = (["a", "b"] as const)
    .map((s) => fonts[s]?.familyName?.replace(/\s+/g, ""))
    .filter((n): n is string => !!n);
  return parts.length ? parts.join("-") : DEFAULT_NAMES[mode];
}
```

- [ ] **Step 5: 테스트 통과 + 전체 타입 확인**

Run: `pnpm exec vitest run src/outputName.test.ts`
Expected: PASS — 4개 통과.

Run: `pnpm exec tsc --noEmit`
Expected: 에러 없음(옵셔널 필드라 기존 `LoadedFont` 리터럴 무영향).

- [ ] **Step 6: 커밋**

```bash
git add src/outputName.ts src/outputName.test.ts src/types.ts
git commit -m "$(cat <<'EOF'
기본 출력 이름 조합기 추가 (deriveDefaultName) + LoadedFont.familyName

A·B familyName을 공백 제거 후 '-'로 연결, 없으면 모드 기본값.
familyName은 옵셔널 — loadFontFile이 채우기 전 증분 컴파일 보장.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: App.tsx wiring — 로드 시 이름 채우기 · 자동 반영 effect · switchMode 단순화

**Files:**
- Modify: `src/App.tsx` (import 2곳 · `loadFontFile` · `lastAutoNameRef` · `switchMode` · effect 추가)

**Interfaces:**
- Consumes: `readFamilyName`(Task 1), `deriveDefaultName`(Task 2), 기존 `DEFAULT_NAMES`·`useRef`·`useEffect`(이미 import됨).
- Produces: (없음 — 최종 wiring)

- [ ] **Step 1: import에 `readFamilyName`·`deriveDefaultName` 추가**

7행 `import { readUnitsPerEm } from "./fontUtils";` 를 아래로 바꾸고, 그 다음 줄에 `deriveDefaultName` import를 추가한다.

```ts
import { readFamilyName, readUnitsPerEm } from "./fontUtils";
import { deriveDefaultName } from "./outputName";
```

- [ ] **Step 2: `lastAutoNameRef` 추가**

`mergeKeyRef` 선언(69행) 바로 아래에 추가한다.

```ts
  // 마지막으로 자동 채운 출력 이름 — 입력칸이 자동값 그대로인지(=사용자 미편집) 판정용.
  const lastAutoNameRef = useRef(DEFAULT_NAMES.basic);
```

- [ ] **Step 3: `loadFontFile`에서 `familyName` 채우기**

`loadFontFile` 안, 105–106행의 `readUnitsPerEm` 호출과 `setFonts`를 아래로 교체한다.

기존:
```ts
      const upem = readUnitsPerEm(buffer);
      setFonts((prevFonts) => ({ ...prevFonts, [slot]: { family, fileName: file.name, upem } }));
```
교체:
```ts
      const upem = readUnitsPerEm(buffer);
      // name 테이블 패밀리 이름(없으면 파일명 stem) — 기본 출력 이름 생성용.
      const familyName = readFamilyName(buffer) ?? file.name.replace(/\.[^.]+$/, "");
      setFonts((prevFonts) => ({ ...prevFonts, [slot]: { family, fileName: file.name, upem, familyName } }));
```

- [ ] **Step 4: `switchMode` 단순화**

257–267행의 `switchMode` 전체를 아래로 교체한다(이름 교체 로직은 Step 5의 effect로 이관).

기존:
```ts
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
```
교체:
```ts
  // 모드 전환 — 이름 자동 반영은 아래 effect가 담당(mode가 의존성). 여기선 모드만 바꾼다.
  function switchMode(next: MergeMode) {
    if (next === mode) return;
    setMode(next);
  }
```

- [ ] **Step 5: 자동 반영 effect 추가**

Step 4에서 교체한 `switchMode` 바로 아래(271행의 `mergeFontsRef` 갱신 effect 앞)에 추가한다.

```ts
  // 기본 출력 이름 자동 반영 — 폰트 로드·교체·스왑·모드 전환마다 A-B 이름으로 갱신하되,
  // 사용자가 입력칸을 직접 편집했으면(자동값과 달라졌으면) 그 값을 지킨다. 빈칸은 "미편집"으로 간주.
  // outName은 의도적으로 의존성에서 제외 — 사용자 타이핑이 이 effect를 재발화시키지 않게 한다.
  useEffect(() => {
    const next = deriveDefaultName(fonts, mode);
    if (outName === lastAutoNameRef.current || outName.trim() === "") {
      lastAutoNameRef.current = next;
      setOutName(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fonts, mode]);
```

- [ ] **Step 6: 타입·린트·빌드 검증**

Run: `pnpm exec tsc --noEmit`
Expected: 에러 없음.

Run: `pnpm lint`
Expected: 에러 없음(effect의 exhaustive-deps는 주석으로 억제됨).

Run: `pnpm exec vitest run`
Expected: PASS — 전체 테스트 스위트 통과(fontUtils·outputName·syntax·status).

- [ ] **Step 7: 수동 검증 (실제 앱)**

Run: `pnpm tauri dev`

확인 절차:
1. `sample/DepartureMono-Regular.otf` 를 슬롯 A에, `sample/LXGWWenKaiMonoKR-Regular.ttf` 를 슬롯 B에 드롭.
2. **출력 이름 입력칸이 `DepartureMono-LXGWWenKaiMonoKR`로 자동 표시**되는지 확인.
3. 입력칸을 `MyCustom`으로 편집 → 슬롯 B에 다른 폰트를 다시 드롭 → **`MyCustom`이 유지**되는지 확인(자동 갱신 안 됨).
4. 입력칸을 비운 뒤 슬롯 A에 다른 폰트 드롭 → **새 A-B 이름으로 다시 자동채움**되는지 확인.
5. (basic 모드) A만 로드된 상태에서 입력칸이 A 이름만 표시하는지, B 로드 시 `A-B`로 갱신되는지 확인.
6. 병합 → `TTF로 저장…` → 저장 대화상자 기본 파일명이 `DepartureMono-LXGWWenKaiMonoKR.ttf`인지 확인.

- [ ] **Step 8: 커밋**

```bash
git add src/App.tsx
git commit -m "$(cat <<'EOF'
출력 이름 자동 생성 wiring — 로드 시 이름 채우기·자동 반영 effect

폰트 로드 시 readFamilyName으로 familyName 저장, effect가 입력칸이
미편집 상태일 때만 deriveDefaultName 결과로 갱신. switchMode의 이름
교체 로직을 이 effect(mode 의존)로 이관해 단순화.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- name 테이블 읽기(우선순위·UTF-16BE·폴백) → Task 1 ✅
- `LoadedFont.familyName` → Task 2 Step 1 ✅
- 조합 규칙(공백 제거·하이픈·모드 폴백) → Task 2 ✅
- 자동 반영 시점(미편집 판정·lastAutoNameRef·effect) → Task 3 Step 2·5 ✅
- switchMode 흡수 → Task 3 Step 4 ✅
- 파일명 폴백 → Task 3 Step 3 ✅
- 병합 루프 불간섭(name은 remerge trigger 제외) → 기존 코드 유지, 변경 없음 ✅
- 테스트 전략(readFamilyName·deriveDefaultName 단위 + 수동) → Task 1·2 단위, Task 3 Step 7 수동 ✅

**타입 일관성:** `readFamilyName(ArrayBuffer): string | null`, `deriveDefaultName(Record<SlotId, LoadedFont|null>, MergeMode): string`, `LoadedFont.familyName?: string` — 3개 태스크에서 시그니처·이름 일치 확인 ✅

**Placeholder 스캔:** TBD/TODO/"적절히 처리" 없음. 모든 코드 스텝에 실제 코드 포함 ✅

**Spec 대비 미세 조정(의도적):** `familyName`을 spec의 `string`이 아닌 옵셔널 `string?`로 — 증분 컴파일 보장용, 런타임 동작 동일(Task 2 Note에 명시).
