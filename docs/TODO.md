# 작업 체크리스트 — Phase 0~6

> 폰트 머지 툴의 Phase별 작업 목록과 완료 기준. 프로젝트 정의·진행 원칙은 [CLAUDE.md](../CLAUDE.md), 기술 제약·레퍼런스는 [REFERENCE.md](REFERENCE.md) 참고.

---

## Phase 0 — 프로젝트 셋업 · (반나절)

- [x] **0a.** Tauri 프로젝트 초기화 (프론트 프레임워크 택1: React/Svelte/Vanilla — 편한 걸로) → react-ts + Vite 6 + pnpm
- [x] **0b.** 저장소 구조 잡기 — `src/`(프론트), `src-tauri/`(Rust), `scripts/`(Python 병합 엔진)
- [x] **0c.** Python 환경 + fonttools 설치 (uv 프로젝트, `uv run --directory scripts merge.py`), 최소 실행 확인
- [x] **0d.** `LICENSE`(MIT), `.gitignore`, 빈 `README.md`

**완료 기준:** `tauri dev`로 빈 창이 뜨고, `python scripts/merge.py` 스켈레톤이 에러 없이 실행됨.

---

## Phase 1 — 미리보기 UI (심장) · 병합 없이 웹뷰만

- [x] **1a.** FontFace API로 아무 TTF 하나 로드 → `textarea`/`contenteditable`에 적용 · (반나절)
  - `const face = new FontFace('preview', buffer); await face.load(); document.fonts.add(face);`
- [x] **1b.** 편집 가능한 미리보기 영역 + **한영 혼용 기본 샘플 텍스트** · (반나절) → 1a와 함께 구현됨
  - 기본값 예: `안녕하세요 Hello 123 반갑습니다 Typography`
  - 열자마자 두 폰트가 함께 작동하는 "그 순간"이 보여야 함
- [x] **1c.** 실시간 컨트롤: `font-size` · `line-height` 슬라이더 · (반나절)
  - **CSS만으로 처리 — 재병합 없음, 0ms 실시간.** 이게 즉시성의 핵심
- [x] **1d.** 폰트 파일 선택/드래그&드롭 UI (아직 Rust 연결 X, 프론트에서 `ArrayBuffer`로 읽기) · (반나절~하루) → A/B 슬롯 + CSS 폴백 조합 미리보기, dragDropEnabled:false 필요

**완료 기준:** 아무 폰트나 던지면 타이핑되고, 크기·줄높이가 실시간으로 조절됨. 병합은 아직 없음. **여기서 "오 되네" 순간이 옴.**

---

## Phase 2 — fonttools 병합 스크립트 · 앱과 무관하게 CLI 단독

- [x] **2a.** 두 폰트 TTF(`glyf` 테이블) 검증 + 로드 · (반나절)
  - `glyf` 없으면(=CFF) 거부. Merger는 glyf만 지원 (Phase 7에서 정적 OTF는 로드 시 TTF 변환으로 완화)
- [x] **2b.** em 크기 통일 · (반나절) → 기본값은 두 폰트 중 큰 upem으로 확대(정밀도 보존), --upem으로 강제 가능
  - `from fontTools.ttLib.scaleUpem import scale_upem` → `scale_upem(font, 1000)`
  - 안 맞추면 A글자·B글자 크기가 따로 놀음
- [x] **2c.** `Merger().merge([...])` 병합 + **A우선 순서** · (반나절)
  - **영문 폰트를 리스트 첫 번째로** 두면 겹치는 라틴/숫자/문장부호 cmap에서 A가 이김
  - 이게 이 프로젝트의 진짜 요구사항 (한글 폰트의 라틴을 좋은 영문으로 눌러쓰기)
- [x] **2d.** name 테이블 재작성 — 출력 폰트 패밀리 이름 지정 · (반나절~하루)
  - 두 폰트 name 충돌 방지 + OFL의 "원래 폰트 이름 재사용 금지" 준수
- [x] **2e.** CLI 인터페이스 · (반나절)
  - 예: `python merge.py a.ttf b.ttf --name "MyMerge" --base A -o out.ttf`

**완료 기준:** 터미널에서 영문+한글 TTF 두 개 → 하나의 TTF. 설치해서 타이핑하면 **A의 라틴 + B의 한글**, 크기 일관, 커닝 살아있음.

---

## Phase 3 — Rust 접착제로 연결 · 최대 난관

- [x] **3a.** persistent Python 사이드카 구조 · (하루) → scripts/sidecar.py, JSON 라인 프로토콜, 앱 시작 시 워밍업
  - 앱 시작 시 Python 프로세스 1회 기동 → stdin/stdout으로 명령 대기
  - **매 병합마다 새로 띄우지 말 것** — 인터프리터 콜드 스타트 + fonttools import 비용이 병합 자체보다 클 수 있음
- [x] **3b.** Rust `invoke` 핸들러 — 프론트에서 두 폰트 경로 받아 사이드카에 전달 · (반나절) → 웹뷰는 경로를 모르므로 바이트 업로드(upload_font) 방식
- [x] **3c.** 병합 결과(TTF 버퍼)를 프론트로 반환 → **Phase 1 미리보기에 주입** · (반나절) → raw IPC(ArrayBuffer)
- [x] **3d.** 로딩 상태 UI — 병합 중 스피너/진행감 · (반나절)
  - 첫 병합(폰트 교체)은 어차피 2~6초. 여기선 예쁜 로딩으로 커버

**완료 기준:** 앱에서 폰트 두 개 고르고 버튼 → 몇 초 뒤 미리보기에 병합 결과가 뜨고 타이핑됨. **루프 성립.** 여기까지가 진짜 MVP.

---

## Phase 4 — 제품화 · 워크플로 완성

- [x] **4a.** A/B 스왑 버튼 (재병합) — "누가 라틴을 이기나"를 UI로 노출 · (반나절) → Rust 스왑 성공 후 프론트 반영(원자성), 상태바에 "라틴 우선: 파일명" 상시 표시
- [x] **4b.** 결과 캐시 — 같은 A+B 조합 재사용, 스왑 왕복 시 즉각 반응 · (반나절) → (A업로드seq, B업로드seq, 이름) 키, 슬롯 교체 시 관련 항목만 무효화
- [x] **4c.** 출력 폰트 이름 입력 필드 → 2d의 name 재작성에 연결 · (반나절)
- [x] **4d.** 병합 결과 저장/export (파일 다이얼로그) · (반나절) → tauri-plugin-dialog, 캐시 복원 시에도 export 대상 동기화(set_merged)
- [x] **4e.** 에러 처리 — TTF 아님 / CFF / 손상 / em 이상값 → 친절한 메시지 · (하루) → 전 구간 한국어 메시지, 사이드카 자동 재기동, 업로드 유니크 파일명

**완료 기준:** 남이 써도 안 깨지고, 워크플로(고르기 → 보기 → 스왑 → 이름 → 저장)가 매끄러움.

---

## Phase 6 — 코딩 폰트 모드 (jetendard식) · Phase 5 릴리스보다 먼저 진행

> 동기: 긱뉴스 스레드 + [kuskhan/jetendard](https://github.com/kuskhan/jetendard). CLI로 반복 조정하던 코딩 폰트 제작(JetBrains Mono + Pretendard, `--korean-scale` 등)을 GUI 슬라이더로 조정하고 즉시 미리보기로 확인. "B의 CJK 우선"도 여기 포함.

- [x] **6a.** merge.py 스타일 파라미터화 — `apply_style_bits`(fsSelection/macStyle/usWeightClass) + `--style`(Regular/Bold/Italic/Bold Italic)
- [x] **6b.** `scripts/fitmerge.py` — jetendard식 글리프 복사 엔진. `Merger` 대신 라틴 A를 베이스로 B의 CJK를 펜 파이프라인(DecomposingRecordingPen→TransformPen→TTGlyphPen)으로 셀에 맞춰 스케일·중앙정렬·복사. `korean_scale`은 상한이고 셀·세로 안전범위를 넘는 글리프는 개별 자동 축소(capped)
- [x] **6c.** 조합형 자모 ccmp(GSUB) — L+V(+T)→완성형 음절 리가처. A의 기존 GSUB(리가처)를 deepcopy 사본에 append + 시험 컴파일 후 반영, 실패 시 원본 롤백(degrade)
- [x] **6d.** 배관 — 사이드카 `mode`(basic/mono) 디스패치, Rust `merge_fonts` 옵션 passthrough(예약 키는 Rust가 마지막에 삽입), `get_merge_stats`로 통계 노출
- [x] **6e/f.** UI — 병합 모드 세그먼트 + 접히는 고급 패널(한글 스케일·폭 배수·세로 오프셋·한자·전각 담당·자모 ccmp) + 스타일 드롭다운, 옵션 전체를 캐시 키에 반영, `merged` 상태에서 옵션 변경 시 500ms debounce 자동 재병합(동시 병합 금지·trailing 1회 코얼레싱)
- [x] **6h.** 소스 글리프 분석 캐시 — 기록+바운즈(scale 무관, ~3.6s)를 B 신원별로 사이드카에 캐시해 재조정 루프 ~6s→~2.4s
- [x] **6g.** 문서 갱신 — 이 Phase 6 체크리스트 + REFERENCE.md mono 엔진 노트
- [x] **6i.** basic 모드 CJK 담당(`cjk_source`, 기본 B) — 병합 전 지는 쪽 cmap에서 교집합 CJK 삭제로 first-wins 우회. `--cjk` CLI·UI 세그먼트·상태줄 표시
- [x] **6j.** 모드 UX — 담당 어휘 통일(라틴/CJK/전각 담당) + 슬롯·상태줄 문구 모드 인식, 모드 툴팁을 출력물 언어로, A 고정폭 감지(사이드카 `inspect` = `check_monospace` 단일 진실원) → 코딩 폰트 모드 추천 배지

**완료 기준:** 앱에서 "코딩 폰트(고정폭)" 모드로 영문 고정폭 + 한글 → 2:1 정렬 코딩 폰트가 나오고, 한글 스케일 슬라이더를 움직이면 몇 초 안에 재병합돼 미리보기가 갱신됨. 일반 병합 모드는 기존 그대로.

---

## Phase 7 — OTF(CFF) 입력 지원 · Phase 5 릴리스보다 먼저

> 동기: OTF+OTF / OTF+TTF / TTF+OTF 조합 지원 요청. Merger는 CFF를 못 합치므로 정적 OTF를 로드 시점에 cu2qu로 TTF 변환(디스크 캐시) — 엔진 무변경. **출력은 항상 TTF**, CFF2(가변)는 거부. 상세는 [REFERENCE.md](REFERENCE.md) "OTF(CFF) 입력" 절.

- [x] **7a.** `scripts/otf2ttf.py` 변환 모듈 + CLI + 첫 pytest(`test_otf2ttf.py`, in-memory CFF 픽스처) · (반나절)
- [x] **7b.** `load_ttf` 통합 — 변환 훅 + `.ttfcache` 디스크 캐시(mtime 신선도) + CFF2 거부 · (반나절)
- [x] **7c.** 사이드카 `inspect`에 `converted_from_otf` 필드 + Rust 교체 시 캐시 청소 · (한두 시간)
- [x] **7d.** 프론트 — 확장자 게이트 `.otf` 허용, 슬롯 "OTF→TTF" 배지(툴팁: 곡선 근사·힌팅 소실), inspect `ok:false`를 슬롯 에러로 표면화(CFF2가 업로드 시점에 보임), 문구 TTF/OTF · (반나절)
- [x] **7e.** 실폰트 검증 — OFL OTF(Noto Sans KR, Source Code Pro)로 CLI 4조합 매트릭스 + 앱 확인 · (반나절) → 수동 검증 완료 (DepartureMono OTF + LXGW WenKai Mono KR)

**완료 기준:** 4개 입력 조합 모두 CLI·앱에서 병합·저장되고, OTF 업로드 시 배지가 뜨며, 재조정 루프 속도는 TTF와 동일(변환은 업로드 시 1회).

---

## Phase 5 — 오픈소스 릴리스

- [ ] **5a.** 크로스플랫폼 빌드 — PyInstaller 사이드카 번들 (win/mac/linux) · (하루+)
  - **가장 골치아픈 구간.** 플랫폼별로 사이드카 바이너리를 따로 빌드/번들해야 함
  - → **Windows 완료**: onefile(console·upx없음·fontTools 전체 hiddenimports) + `pnpm build:sidecar`(rustc 트리플 배치) + 스모크 게이트(`scripts/smoke_sidecar.py`, lazy=False 전 테이블 디컴파일) + Tauri externalBin·dev/prod spawn 분기(`cfg!(debug_assertions)`) + NSIS/MSI 산출·무설치 실행 스모크 확인. mac/linux는 5d CI에서(크로스컴파일 불가). + CI(release.yml)가 무설치 포터블 zip(font-moeum.exe + sidecar.exe)도 만들어 릴리스에 첨부
- [x] **5b.** README — 스크린샷/데모 GIF, 사용법, **지원 범위 명시(입력 TTF/정적 OTF · 출력 TTF, A+B)** · (반나절) → 본문 완료(설치·사용법·병합 모드·소스 빌드·disclaimer·크레딧). 스크린샷/GIF는 docs/media/ 슬롯 + 캡처 가이드 주석으로 준비, 실제 캡처만 남음
- [x] **5c.** 라이선스 정리 — MIT + "머지할 폰트 라이선스는 사용자 책임" disclaimer + 데모 폰트는 OFL/Apache · (반나절) → sample/에 OFL 사본·출처 표, .gitignore 화이트리스트, disclaimer는 README에
- [ ] **5d.** (선택→**필수 승격**) GitHub Actions CI 자동 빌드 — mac/linux 바이너리는 CI가 유일한 경로 · (하루)

**완료 기준:** GitHub에 올리고 릴리스에 바이너리 첨부. 남이 다운받아 바로 실행 가능.

> ⚠️ **현실 체크:** MVP(Phase 3) 완성 후 "다 됐다" 싶을 때 실제론 절반쯤 온 것. Phase 4~5의 "남이 쓸 수 있게" 만드는 구간이 MVP만큼 걸림.
