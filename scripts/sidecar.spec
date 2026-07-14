# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — sidecar.py를 단일 exe로 빌드한다.

빌드: scripts/build_sidecar.py가
    sys.executable -m PyInstaller sidecar.spec --noconfirm
로 이 파일을 구동한다 (cwd=scripts). 직접 돌리려면 scripts/ 안에서
    uv run --directory scripts pyinstaller sidecar.spec --noconfirm

설계 결정 (Task 1 브리프 — 변경 시 근거를 먼저 갱신할 것):

1. onefile — onedir이 아니라 EXE 하나에 binaries/datas를 전부 담는다
   (아래 EXE() 호출에 a.binaries/a.datas를 직접 전달, COLLECT() 없음).
   Tauri externalBin 규약(타깃 트리플 접미사가 붙은 단일 파일)에 맞추기 위함.
   압축해제 비용은 사이드카가 앱 세션당 1회만 기동 + 기존 워밍업 스레드가
   숨기므로 무의미하다.

2. console=True 고정 — windowed(console=False)는 절대 쓰지 않는다.
   merge.py:34-35, fitmerge.py:40-41, otf2ttf.py:21의
   `sys.stdout.reconfigure(...)` / `sys.stderr.reconfigure(...)`가 가드 없이
   모듈 임포트 시점에 실행된다. windowed 빌드는 stdout/stderr가 None이 되므로
   임포트 즉시 AttributeError로 죽는다. 콘솔 창 숨김은 Rust 쪽
   CREATE_NO_WINDOW가 담당하므로 여기서 windowed로 바꿔 대응할 필요가 없다
   (Python 코드 수정 불필요).

3. upx=False — UPX 압축 exe는 백신 오탐(false positive)이 잦다. 사이드카는
   사용자 머신에 배포되는 실행 파일이므로 오탐 완화가 크기 절감보다 우선.

4. hiddenimports = collect_submodules('fontTools') 전체 수집 — fontTools의
   ttLib 테이블 모듈(otTables, S/V/G 등)은 importlib/__import__로 지연 로드되어
   PyInstaller 정적 분석(import 문 스캔)에 잡히지 않는다. 누락되면 크래시가
   아니라 DefaultTable로 조용히 열화되어 "깨진 폰트가 산출"된다 — 이게 이
   빌드에서 가장 위험한 침묵 실패 모드다. tables 서브패키지만 좁게 수집하는
   대안은 cffLib·otlLib 등 2차 지연 임포트 경로를 놓칠 수 있어 기각했다.
   smoke_sidecar.py가 실제 병합 출력을 전 테이블 강제 디컴파일해 이 누락을
   드러낸다.

5. excludes=['tkinter'] — GUI 없는 CLI/사이드카 빌드에 불필요한 의존성 제외.
   pathex=['.'] — scripts/의 flat 모듈(merge, fitmerge, otf2ttf가 패키지가
   아니라 최상위 모듈) 임포트 해석용.
"""

from PyInstaller.utils.hooks import collect_submodules

a = Analysis(
    ['sidecar.py'],
    pathex=['.'],
    binaries=[],
    datas=[],
    hiddenimports=collect_submodules('fontTools'),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,       # onefile: 바이너리 의존성을 exe에 직접 포함 (COLLECT() 없음)
    a.datas,
    [],
    name='sidecar',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,         # 결정 3 — 백신 오탐 완화
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,       # 결정 2 — windowed 금지, 사유는 상단 docstring
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
