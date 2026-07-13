"""사이드카 exe 빌드 오케스트레이터.

scripts/sidecar.spec으로 PyInstaller onefile 빌드를 돌리고, 결과물을 Tauri
externalBin 명명 규약(`<name>-<타깃 트리플>(.exe)`)에 맞춰
src-tauri/binaries/로 복사한다. 타깃 트리플은 `rustc -vV`의 `host:` 줄에서
파싱한다 — Tauri externalBin이 요구하는 접미사와 로컬 rustc의 host triple이
일치해야 하기 때문.

사용법 (repo 루트에서):
    pnpm build:sidecar
    (내부적으로: uv run --directory scripts python build_sidecar.py)

경로는 모두 이 파일(__file__) 기준으로 계산하므로 어느 cwd에서 실행해도 동작한다.
"""

import shutil
import subprocess
import sys
from pathlib import Path

# 한글 진행 메시지를 stdout에 찍는다 — Windows 콘솔 코드페이지(cp949 등)에서
# 깨지거나 죽지 않도록 sidecar.py와 같은 패턴으로 UTF-8 고정.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
SPEC_PATH = SCRIPT_DIR / "sidecar.spec"
DIST_DIR = SCRIPT_DIR / "dist"
BINARIES_DIR = REPO_ROOT / "src-tauri" / "binaries"

EXE_SUFFIX = ".exe" if sys.platform == "win32" else ""


def run_pyinstaller() -> None:
    print(f"[build_sidecar] PyInstaller 빌드 시작 ({SPEC_PATH.name}, cwd={SCRIPT_DIR})")
    try:
        subprocess.run(
            [sys.executable, "-m", "PyInstaller", SPEC_PATH.name, "--noconfirm"],
            cwd=SCRIPT_DIR,
            check=True,
        )
    except FileNotFoundError as e:
        sys.exit(f"오류: PyInstaller를 실행할 수 없습니다 — {e}\n"
                 f"'uv sync --directory scripts --group dev'로 설치되어 있는지 확인하세요.")
    except subprocess.CalledProcessError as e:
        sys.exit(f"오류: PyInstaller 빌드 실패 (종료 코드 {e.returncode})")


def detect_target_triple() -> str:
    """`rustc -vV`의 `host:` 줄에서 타깃 트리플을 파싱한다 (예: x86_64-pc-windows-msvc)."""
    try:
        result = subprocess.run(
            ["rustc", "-vV"], capture_output=True, text=True, check=True,
        )
    except FileNotFoundError:
        sys.exit(
            "오류: rustc를 찾을 수 없습니다 — Rust 툴체인이 설치·PATH에 등록되어 "
            "있는지 확인하세요 (https://rustup.rs). 타깃 트리플 파싱에 필요합니다."
        )
    except subprocess.CalledProcessError as e:
        sys.exit(f"오류: 'rustc -vV' 실행 실패 (종료 코드 {e.returncode}):\n{e.stderr}")

    for line in result.stdout.splitlines():
        if line.startswith("host:"):
            triple = line.split(":", 1)[1].strip()
            if triple:
                return triple
    sys.exit(
        f"오류: 'rustc -vV' 출력에서 'host:' 줄을 찾지 못했습니다:\n{result.stdout}"
    )


def copy_to_binaries(triple: str) -> Path:
    src = DIST_DIR / f"sidecar{EXE_SUFFIX}"
    if not src.is_file():
        sys.exit(f"오류: 빌드 산출물이 없습니다: {src} — PyInstaller 빌드가 실패했을 수 있습니다.")

    BINARIES_DIR.mkdir(parents=True, exist_ok=True)
    dest = BINARIES_DIR / f"sidecar-{triple}{EXE_SUFFIX}"
    shutil.copy2(src, dest)
    return dest


def main() -> None:
    run_pyinstaller()
    triple = detect_target_triple()
    dest = copy_to_binaries(triple)
    print(f"[build_sidecar] 완료: {dest}")


if __name__ == "__main__":
    main()
