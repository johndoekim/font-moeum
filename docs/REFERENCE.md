# 기술 레퍼런스

> Phase 2~3(병합 엔진·미리보기·사이드카) 구현 시 참고. 작업 목록은 [TODO.md](TODO.md), 프로젝트 정의는 [CLAUDE.md](../CLAUDE.md) 참고.

**fonttools Merger 제약 (반드시 지킬 것)**
- 모든 폰트가 TrueType 아웃라인(`glyf`)이어야 함. CFF 병합 미지원 → 입력 검증에서 걸러라
- 모든 폰트의 `unitsPerEm`이 동일해야 함 → `scale_upem`으로 사전 통일
- 중복 글리프 구분이 일어나면 `GSUB` 테이블 필요 — 겹치는 코드포인트가 서로 다른 글리프면 Merger가 synthetic 'locl' SingleSubst를 합성한다
- cmap 소비는 폰트별 format 12(있으면) 아니면 format 4만 — 겹침 처리는 리스트 첫 번째 폰트 승리(first-wins)
- `cjk_source` 옵션(basic 모드)은 병합 전 지는 쪽(base) cmap의 모든 유니코드 서브테이블(format 14 제외)에서 **양쪽이 모두 커버하는** CJK 코드포인트를 삭제해 first-wins를 우회한다. 지는 쪽의 죽은 글리프는 파일에 남고(v1 트레이드오프), OS/2 유니코드 범위는 Merger가 bitwise-or라 무보정으로 정합
- Merger 산출물은 `post` format 3(글리프 이름 소실) — 재로드 시 fontTools가 cmap에서 이름을 합성(`uniAC00` 등)하므로 **글리프 이름으로 출처 판별 불가**. 검증은 hmtx advance 등 실측값으로 할 것
- **한쪽에만 있는 `vhea`/`vmtx`(세로 메트릭)는 Merger가 속성 병합에서 죽는다** — `mergeObjects`가 테이블 부재(NotImplemented)를 속성값으로 흘려 raw `max`/`min`/`equal`과 비교(`'>' not supported between 'int' and 'NotImplementedType'` 류 — 어느 속성이 먼저 터지는지는 set 순회 순서라 에러 문구가 실행마다 다름). 맑은 고딕 등 세로 메트릭 있는 한글 폰트가 걸림 → merge.py가 병합 전 가진 쪽에서 제거(가로쓰기 산출물이라 무해)
- **`JSTF`(양쪽 정렬 데이터)는 Merger 범용 병합이 내부 리스트 속성에서 죽는다**(`type object 'list' has no attribute 'mergeMap'`). Arial·Times 등 MS 폰트가 보유 → merge.py가 병합 전 항상 제거(현대 셰이퍼 미소비, 렌더링 영향 없음)
- 이미 병합된 대형 폰트를 다시 병합해 글리프 합계가 65,535(TTF `numGlyphs` uint16 한계)를 넘으면 저장 단계에서 실패 — 형식의 물리적 한계

**영문+한글 특유의 사실**
- 라틴(U+0041~)과 한글 음절(U+AC00~D7A3)은 유니코드 영역이 완전히 달라 **충돌이 거의 없음** → 이 조합은 병합 중 제일 깨끗한 축
- 겹치는 건 라틴/숫자/문장부호뿐 → **A(영문)를 merge 리스트 첫 번째**에 두면 A가 cmap 기본값 차지
- 세로 메트릭: Merger가 `hhea.ascent`를 두 폰트 중 최댓값으로 자동 조정 → 섞였을 때 붕 뜨는 문제 완화

**미리보기 (심장)**
- `new FontFace(name, arrayBuffer)` → `document.fonts.add(face)` — 파일 저장 불필요
- 병합 결과 바뀔 때마다 패밀리 이름에 버전 suffix를 붙이거나 이전 face를 `document.fonts.delete()`로 정리 (캐시 충돌 방지)
- **`font-size`·`line-height`·색은 전부 CSS — 재병합 없이 0ms 실시간.** 재병합이 필요한 조작은 폰트 교체와 A/B 스왑뿐
- (1d에서 확인) Tauri 창의 `dragDropEnabled`가 기본값(true)이면 Tauri가 드롭을 가로채 HTML5 `drop` 이벤트에 JS `File` 객체가 안 옴(Windows 문서화된 동작). 프론트에서 ArrayBuffer로 읽으려면 **`dragDropEnabled: false` 유지 필수** — 켜면 드래그&드롭이 조용히 깨짐
- (1d에서 구현) 병합 전 미리보기는 `font-family: "A", "B"` CSS 폴백 스택으로 근사 — 라틴은 A가 이기고 한글은 B가 받아, 병합 결과와 같은 조합이 즉시 보임

**체감 속도**
- 첫 병합: 2~6초 (콜드 스타트 잡으면 1~3초)
- persistent 사이드카로 인터프리터 시작 + import 비용 제거가 최대 레버
- 같은 조합 캐시로 스왑 왕복 대응

**라이선스**
- Tauri(MIT/Apache) · fonttools(MIT) — permissive 궁합 OK
- FontForge(GPLv3)는 번들 금지 — 프로젝트가 GPL로 끌려감
- 데모/예제 폰트는 OFL 또는 Apache(구글 폰트 등). OFL은 파생본이 원래 이름 재사용 금지 + OFL 유지

---

**코딩 폰트 모드 (mono 엔진 · `scripts/fitmerge.py`)**

일반 병합(`merge.py`, fontTools `Merger`)과 별개의 엔진. Merger의 UPM 일치 제약·cmap 우선순위 방식 대신, 라틴 A를 베이스로 열고 B의 CJK 글리프를 직접 변환·복사한다.

- **펜 파이프라인:** 소스 글리프당 `DecomposingRecordingPen`으로 1회 기록(컴포지트 평탄화) → `BoundsPen`으로 바운딩 → `TransformPen(TTGlyphPen(...))`으로 A의 `glyf`에 삽입. 아핀 변환은 쿼드라틱을 보존하므로 cu2qu 불필요. UPM은 `scale_upem` 대신 `A.upem/B.upem` 비율을 펜 변환에 흡수 → 최종 폰트 UPM = A 것.
- **스케일은 상한:** `korean_scale`(기본 1.15)은 요청값이고, 셀 폭(라틴×`width_mult`, 기본 2배)이나 A의 세로 안전범위(`min(hhea.ascent, sTypoAscender)` / `max(hhea.descent, sTypoDescender)`)를 넘는 글리프는 개별 자동 축소(capped 통계). 절대 안 깨지므로 슬라이더로 안전하게 노출 가능.
- **고정폭 요구:** A는 반드시 고정폭(모노스페이스). `" A0Hinmw"` 샘플의 advance가 다르면 한국어 에러. 한글 advance = 라틴 advance × width_mult로 고정, 셀 중앙 정렬(세로 이동은 `ty` 옵션, 기본 0).
- **CJK는 B 승리:** cmap의 모든 유니코드 서브테이블(UVS format 14 제외, format 4는 BMP만)에 덮어쓰기 → 겹치는 전각·CJK 구두점도 B가 가짐. 단 `fullwidth_source="A"`면 전각(FF00–FFEF)·CJK 구두점(3000–303F)은 A에 없는 것만 보충.
- **GSUB ccmp:** 조합형 자모 L+V(+T)→완성형 음절 리가처를 생성. A에 기존 GSUB(JetBrains Mono의 calt/liga 등)이 있으면 **feaLib 재빌드 금지**(기존 룩업 교체 → 리가처 사망) — `otlLib`로 룩업을 만들어 deepcopy 사본의 LookupList/FeatureList 끝에 append(기존 인덱스 불변)하고 시험 컴파일 통과 후에만 반영, 실패 시 원본 GSUB으로 롤백. B의 GSUB/GPOS/kern은 가져오지 않는다.
- **세로 메트릭 불변:** hhea/OS/2 세로 메트릭은 A 것 그대로(한글을 그 안에 맞춤). `post.isFixedPitch=1`, panose `bProportion=9`, OS/2 범위 비트 재계산, A의 hdmx/LTSH/VDMX 삭제.
- **재조정 루프 성능:** mono 병합은 첫 회 약 6초(글리프 기록 ~3s + 바운즈 ~0.6s + 저장 ~1.5s + ccmp ~0.7s). 기록·바운즈는 `korean_scale`/`ty`/`width_mult`와 무관하므로 사이드카에 B 신원(경로+mtime+size)별로 캐시 → 슬라이더 조정 재병합은 약 2.4초. 프론트는 옵션 전체를 키로 결과를 캐시하므로 되돌아온 값은 즉시.
