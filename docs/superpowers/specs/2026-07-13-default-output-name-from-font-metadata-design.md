# 설계: 기본 출력 이름 자동 생성 (폰트 메타데이터 기반)

- **날짜:** 2026-07-13
- **상태:** 승인됨 (구현 계획 대기)
- **범위:** 프론트엔드(JS/TS)만. Python 병합 엔진·Rust 접착제 변경 없음.

## 배경 / 문제

현재 출력 폰트 패밀리 이름의 기본값은 모드별 정적 상수다
(`DEFAULT_NAMES = { basic: "MoeumMerged", mono: "MoeumMono" }`,
[src/types.ts](../../../src/types.ts)). 사용자가 A·B 폰트를 로드해도 출력 이름은
매번 같은 상수여서, 결과물이 어떤 두 폰트를 합친 것인지 이름만 봐선 알 수 없다.

**목표:** A·B 폰트의 `name` 테이블에서 실제 패밀리 이름을 뽑아
`A이름-B이름` 형태의 기본 출력 이름을 자동 생성한다. 단 사용자가 직접 입력한
이름은 어떤 경우에도 덮어쓰지 않는다.

## 확정된 결정 (브레인스토밍)

1. **이름 형식 — 컴팩트(공백 제거 · 하이픈 연결).**
   예: `Departure Mono` + `LXGW WenKai Mono KR` → `DepartureMono-LXGWWenKaiMonoKR`.
   표시 이름·PostScript 이름·저장 파일명이 모두 동일해 가장 안전하고 폰트
   네이밍 관례에 맞는다.
2. **자동 반영 시점 — 입력칸이 비었거나 자동값 그대로일 때만 자동 갱신.**
   폰트 로드·교체·스왑·모드 전환마다 갱신하되, 사용자가 한 번 손대면 그 값을 지킨다.

## 동작 요약

- A·B를 로드하면 각 폰트의 `name` 테이블에서 패밀리 이름을 읽어, 각 이름의
  공백을 제거하고 `-`로 이어 기본 출력 이름을 만든다.
- 사용자가 출력 이름 입력칸을 직접 편집하기 전까지만 이 값을 자동 반영한다.
  편집한 뒤에는 자동 갱신을 멈추고 사용자 값을 유지한다.

## 컴포넌트별 설계

### 1) 이름 읽기 — [src/fontUtils.ts](../../../src/fontUtils.ts)

기존 `readUnitsPerEm(buffer)`와 같은 방식으로 sfnt 바이너리에서 `name` 테이블을
직접 파싱하는 순수 함수를 추가한다. React·앱 상태와 무관하므로 단독 테스트 가능.

```
readFamilyName(buffer: ArrayBuffer): string | null
```

**파싱 절차**
- sfnt 테이블 디렉터리에서 `name` 테이블(태그 `0x6E616D65`) 오프셋을 찾는다.
- name 테이블 헤더: `format`(u16), `count`(u16), `stringOffset`(u16).
  이어서 `count`개의 name 레코드(각 12바이트):
  `platformID`(u16), `encodingID`(u16), `languageID`(u16), `nameID`(u16),
  `length`(u16), `offset`(u16). 문자열 저장소 시작 = name 테이블 오프셋 + `stringOffset`.
- **레코드 선택 우선순위:**
  1. nameID 16(Typographic/Preferred Family), platformID 3(Windows)
  2. nameID 1(Family), platformID 3
  3. nameID 16, platformID 1(Mac)
  4. nameID 1, platformID 1
  5. nameID 16(플랫폼 무관) → nameID 1(플랫폼 무관)
- **디코딩:** Windows(platformID 3) 레코드는 UTF-16BE로 디코드. Mac(platformID 1)
  레코드는 ASCII/Latin1(MacRoman 근사)로 디코드. 디코드 후 `trim()`.
- 어떤 후보도 없거나 파싱 실패 시 `null` 반환(호출부가 파일명으로 폴백).

**동작 보장**
- OTF(CFF)도 sfnt 구조가 동일하므로 그대로 동작한다. 병합용 OTF→TTF 변환과
  무관하게 **원본 폰트의 name 테이블**을 읽는다.
- `readUnitsPerEm`과 같은 방어적 스타일: 손상/비정상 sfnt는 `null` 폴백.

### 2) 도메인 타입 — [src/types.ts](../../../src/types.ts)

`LoadedFont`에 필드 추가:

```
familyName: string; // name 테이블 패밀리 이름(없으면 파일명 stem 폴백) — 기본 출력 이름 생성용
```

`loadFontFile`에서 `readFamilyName(buffer) ?? <파일명 확장자 제거>`로 채운다.
즉 항상 사람이 알아볼 수 있는 문자열이 들어간다.

### 3) 조합 규칙 — [src/App.tsx](../../../src/App.tsx)

순수 헬퍼:

```
deriveDefaultName(fonts, mode): string
```

- 로드된 슬롯(a, b 순)의 `familyName`을 모아 각각 내부 공백을 제거한 뒤 `-`로 join.
- A만/B만 로드 → 그 하나만 반환.
- 둘 다 없음 → 기존 정적 `DEFAULT_NAMES[mode]` 반환.

표시 이름(name ID 1/16)만 이 값을 쓴다. PostScript 이름(name ID 6)은 Python
`rewrite_names`가 이미 `"".join(family.split())`로 공백을 제거하고, 하이픈 포맷
자체가 파일명·PostScript 모두에 안전하므로 추가 정리 로직은 두지 않는다.

### 4) 자동 반영 시점 — [src/App.tsx](../../../src/App.tsx)

`lastAutoNameRef`(useRef)로 "마지막으로 자동 채운 값"을 추적한다.
초기값 = `DEFAULT_NAMES.basic`(= `outName` 초기값과 동일).

effect 의존성 `[fonts.a, fonts.b, mode]`:
1. `next = deriveDefaultName(fonts, mode)`.
2. **입력칸이 "안 건드려짐"** 인지 판정:
   `outName === lastAutoNameRef.current || outName.trim() === ""`.
3. 안 건드려졌으면 `setOutName(next)` + `lastAutoNameRef.current = next`.
   건드려졌으면(사용자 편집) 아무것도 하지 않는다.

**결과로 `switchMode` 단순화:** 기존 `switchMode`의 "현재 이름이 빈칸/기본값이면
새 모드 기본값으로 교체" 로직을 이 effect가 흡수한다(mode가 의존성에 있음).
`switchMode`는 `setMode(next)`만 남는다.

**병합 루프와의 상호작용**
- 폰트 로드는 이미 `clearMerged()`로 `merged = null`이라, 이름 자동 갱신이 진행
  중인 병합과 충돌하지 않는다.
- 이름 변경은 `buildRemergeTrigger()`(name 제외)에 안 들어가므로 이름 자동
  갱신만으로 자동 재병합이 발화하지 않는다. 캐시 키(`mergeKey`)에는 name이
  포함되어, 다음 실제 병합 시 최신 이름이 반영된다. (기존 불변식 유지)

## 영향 파일

| 파일 | 변경 |
|------|------|
| `src/fontUtils.ts` | `readFamilyName(buffer)` 추가 |
| `src/types.ts` | `LoadedFont.familyName` 필드 추가 |
| `src/App.tsx` | `loadFontFile`에서 familyName 채움 · `deriveDefaultName` · 자동 반영 effect · `switchMode` 단순화 |

Python(`scripts/`)·Rust(`src-tauri/`) 변경 없음.

## 엣지 케이스

- **name 테이블 없음/손상:** `readFamilyName`이 `null` → 파일명 stem으로 폴백.
- **UTF-16BE 디코딩:** Windows 레코드는 UTF-16BE. 서로게이트 페어 포함 정상 디코드.
- **빈칸 처리:** 입력칸이 빈 문자열이면 "안 건드려짐"으로 간주해 폰트 교체 시
  재자동채움. 빈칸은 어차피 `buildOptions`에서 기본값으로 폴백되므로 무해.
- **이름에 이미 하이픈 포함**(예: 파일명 폴백 `DepartureMono-Regular`): 그대로 둔다
  (경미 — 스타일 접미어 제거는 범위 밖).
- **한 슬롯만 로드:** 그 슬롯 이름만으로 기본값 생성, 나머지 로드 시 갱신.

## 테스트 전략

- **`readFamilyName` 단위 테스트**(fontUtils는 순수 함수라 단독 가능):
  - Windows(3,1) nameID 16/1 UTF-16BE 정상 추출.
  - nameID 16 우선, 없으면 1 폴백.
  - name 테이블 없음/손상 → `null`.
  - OTF(CFF) 바이너리에서도 추출.
- **`deriveDefaultName` 단위 테스트:** A+B, A만, B만, 둘 다 없음, 공백 제거·하이픈.
- **수동 검증:** `sample/DepartureMono-Regular.otf` + `sample/LXGWWenKaiMonoKR-Regular.ttf`
  로드 → 입력칸에 `DepartureMono-LXGWWenKaiMonoKR` 자동 표시 → 사용자가 편집 후
  다른 폰트 교체 시 편집값 유지 확인.

## 비목표 (YAGNI)

- 파일명 stem에서 `-Regular`/`-Bold` 등 스타일 접미어 자동 제거.
- 임의 사용자 입력에 대한 파일명·PostScript 정제 강화(선택 포맷은 이미 안전).
- 세 번째 이상 폰트/다국어 name 레코드 로케일 선택 UI.
