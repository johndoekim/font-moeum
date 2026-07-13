"""사이드카 실행 파일(exe) 스모크 테스트 — JSON 라인 프로토콜로 실제 구동한다.

사용법:
    python smoke_sidecar.py <exe 경로>

<exe 경로>는 절대/상대 무엇이든 된다 — Path(...).resolve()로 정규화한다.
(개발 중에는 venv 파이썬으로 `sidecar.py`를 직접 실행해 하네스 로직을 먼저
검증한 뒤 빌드된 exe에 적용하는 순서를 권장한다 — 이 스크립트 자체는 exe 경로
하나만 인자로 받으므로, venv 검증 시에는 별도 구동 방식으로 대체해 확인한다.)

exe를 subprocess로 spawn(stdin/stdout 파이프)해 실제 프로토콜
(ping → merge×2 → inspect → quit)로 구동하고, 병합 출력 폰트를
`TTFont(path, lazy=False)` + `ensureDecompiled(recurse=True)`로 강제
전체 디컴파일한다. hiddenimports 누락 시 fontTools가 해당 테이블을
DefaultTable로 조용히 열화시키는데(크래시하지 않음), 이후 cmap/name/hmtx/GSUB
단언이 그 열화를 드러낸다. 이게 이 태스크의 핵심 품질 게이트 — venv 파이썬으로
sidecar.py를 직접 돌리면 통과하는데 빌드된 exe에서만 실패한다면 그건
PyInstaller 번들링 문제(원하는 신호)다.

실패 시 무엇이 실패했는지 stderr에 메시지를 남기고 종료코드 1.
성공 시 요약을 stdout에 남기고 종료코드 0.
"""

import json
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from fontTools.ttLib import TTFont

# 이 스크립트 자체가 한글/em-dash를 stdout·stderr에 찍는다 — Windows 콘솔
# 코드페이지(cp949 등)에서 UnicodeEncodeError로 죽지 않도록 sidecar.py와 같은
# 패턴으로 UTF-8 고정.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

SCRIPTS_DIR = Path(__file__).resolve().parent
SAMPLE_DIR = SCRIPTS_DIR.parent / "sample"
FONT_A = SAMPLE_DIR / "JetBrainsMono-Regular.ttf"
FONT_B = SAMPLE_DIR / "D2Coding-Ver1.3.2-20180524.ttf"


class SmokeFailure(Exception):
    """스모크 테스트 실패 — 메시지가 그대로 사용자에게 보인다."""


class SidecarProcess:
    """exe를 spawn해 stdin/stdout 파이프로 JSON 라인을 주고받는 얇은 래퍼."""

    def __init__(self, exe_path: Path):
        self.proc = subprocess.Popen(
            [str(exe_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        # stderr를 백그라운드에서 계속 드레인한다 — 안 읽고 쌓아두면 OS 파이프
        # 버퍼가 차서 사이드카가 stderr write()에서 블록되고, 그러면 stdout 응답도
        # 못 내놔 우리 쪽 readline()과 서로 기다리는 데드락에 빠진다. merge.py/
        # fitmerge.py는 진행 로그를 stderr로 계속 찍으므로(예: OTF 변환, upem 통일)
        # 실제로 트리거된다. Rust 쪽은 이 위험을 Stdio::inherit()로 원천 회피한다
        # (src-tauri/src/lib.rs:40) — 우리는 파이프로 캡처해야 실패 시 보여줄 수
        # 있으므로 스레드로 계속 읽어 데드락 없이 buffered 로그를 유지한다.
        self._stderr_lines: list[str] = []
        self._stderr_lock = threading.Lock()
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            with self._stderr_lock:
                self._stderr_lines.append(line)

    def stderr_tail(self, n: int = 60) -> str:
        with self._stderr_lock:
            return "".join(self._stderr_lines[-n:])

    def send(self, req: dict) -> dict | None:
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        if req.get("cmd") == "quit":
            return None  # 프로토콜상 quit은 응답 없음
        out = self.proc.stdout.readline()
        if not out:
            raise SmokeFailure(
                f"사이드카가 응답 없이 종료했습니다 (요청: {req}).\n"
                f"최근 stderr:\n{self.stderr_tail()}"
            )
        return json.loads(out)

    def close(self, timeout: float = 15.0) -> int:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            raise SmokeFailure("사이드카가 quit 이후 시간 내 종료하지 않았습니다 (강제 종료함)")

    def kill(self) -> None:
        try:
            self.proc.kill()
        except Exception:
            pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def check_ping(sc: SidecarProcess) -> None:
    resp = sc.send({"cmd": "ping"})
    _require(resp is not None and resp.get("ok") is True, f"ping 실패: {resp}")
    _require(bool(resp.get("fonttools")), f"ping 응답에 fonttools 버전이 없습니다: {resp}")
    print(f"  ping OK (fonttools {resp['fonttools']})", flush=True)


def _assert_merged_font(path: Path, expected_name: str) -> TTFont:
    """전 테이블 강제 디컴파일 + cmap/name 공통 단언. 검증된 TTFont를 반환한다.

    lazy=False만으로는 개별 테이블이 첫 접근 시점까지 지연 디컴파일되므로,
    ensureDecompiled(recurse=True)로 하위 구조(글리프·서브테이블 등)까지 강제
    디컴파일한다 — hiddenimports 누락으로 인한 DefaultTable 열화를 여기서
    표면화시키는 지점.
    """
    font = TTFont(str(path), lazy=False)
    font.ensureDecompiled(recurse=True)

    cmap = font.getBestCmap()
    _require(cmap is not None, f"{path}: cmap을 읽을 수 없습니다")
    _require(0xAC00 in cmap, f"{path}: cmap에 U+AC00('가')이 없습니다")
    _require(0x0041 in cmap, f"{path}: cmap에 U+0041('A')이 없습니다")

    family = font["name"].getDebugName(1)
    _require(family == expected_name,
             f"{path}: name 테이블 패밀리 '{family}' != 기대값 '{expected_name}'")
    return font


def check_merge_basic(sc: SidecarProcess, tmp_dir: Path) -> None:
    out_path = tmp_dir / "basic.ttf"
    req = {
        "cmd": "merge", "mode": "basic",
        "font_a": str(FONT_A), "font_b": str(FONT_B), "output": str(out_path),
        "name": "MoeumSmokeBasic", "base": "A", "style": "Regular",
    }
    resp = sc.send(req)
    _require(resp is not None and resp.get("ok") is True, f"basic 병합 실패: {resp}")
    _require(out_path.is_file(), f"basic 병합 응답은 ok지만 출력 파일이 없습니다: {out_path}")

    _assert_merged_font(out_path, "MoeumSmokeBasic")
    print(f"  merge(basic) OK — {resp.get('elapsed')}초, {out_path.name}", flush=True)


def check_merge_mono(sc: SidecarProcess, tmp_dir: Path) -> None:
    out_path = tmp_dir / "mono.ttf"
    req = {
        "cmd": "merge", "mode": "mono",
        "font_a": str(FONT_A), "font_b": str(FONT_B), "output": str(out_path),
        "name": "MoeumSmokeMono", "style": "Regular", "jamo_ccmp": True,
    }
    resp = sc.send(req)
    _require(resp is not None and resp.get("ok") is True, f"mono 병합 실패: {resp}")
    _require(out_path.is_file(), f"mono 병합 응답은 ok지만 출력 파일이 없습니다: {out_path}")

    font = _assert_merged_font(out_path, "MoeumSmokeMono")

    stats = resp.get("stats", {})
    latin_advance = stats.get("latin_advance")
    korean_advance = stats.get("korean_advance")
    _require(isinstance(latin_advance, int) and isinstance(korean_advance, int),
             f"mono stats에 latin_advance/korean_advance가 없습니다: {stats}")
    _require(korean_advance == latin_advance * 2,
             f"stats: 한글 advance({korean_advance}) != 라틴 advance({latin_advance}) x 2")

    # stats 자기보고뿐 아니라 실제 저장된 hmtx도 동일한지 확인 — stats와 실제
    # 산출물이 어긋나는 것도 열화의 한 형태일 수 있다.
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    hangul_glyph = cmap[0xAC00]
    latin_glyph = cmap[0x0041]
    hangul_advance = hmtx[hangul_glyph][0]
    real_latin_advance = hmtx[latin_glyph][0]
    _require(hangul_advance == real_latin_advance * 2,
             f"실제 hmtx: 한글 advance({hangul_advance}) != "
             f"라틴 advance({real_latin_advance}) x 2")

    # jamo_ccmp=True로 GSUB 경로까지 태움(자모 합성 리가처 생성) — otlLib/otTables가
    # 프리즈 번들에서 누락되면 fit_merge_to_file이 예외를 삼키고 ccmp_rules=0 +
    # warnings로 조용히 열화한다. 여기서 그 조용한 열화를 실패로 잡는다.
    ccmp_rules = stats.get("ccmp_rules")
    warnings = stats.get("warnings") or []
    _require(ccmp_rules is not None and ccmp_rules > 0,
             f"mono stats.ccmp_rules가 0 이하입니다({ccmp_rules}) — jamo ccmp(GSUB) 경로가 "
             f"실패했을 수 있습니다. warnings={warnings}")
    _require("GSUB" in font, "mono 결과에 GSUB 테이블이 없습니다 — jamo ccmp 경로 실패")
    _require(not warnings, f"mono 병합이 경고를 냈습니다(조용한 열화 가능성): {warnings}")

    print(f"  merge(mono) OK — {resp.get('elapsed')}초, ccmp_rules={ccmp_rules}, "
          f"{out_path.name}", flush=True)


def check_inspect(sc: SidecarProcess, tmp_dir: Path) -> None:
    # scripts/test_otf2ttf.py의 in-memory CFF 픽스처 빌더 재사용 — CFF→TTF
    # 변환(cu2qu) 경로가 번들에서도 살아있는지 inspect를 통해 확인한다.
    sys.path.insert(0, str(SCRIPTS_DIR))
    from test_otf2ttf import build_cff_font  # noqa: E402 (경로 준비 후 임포트)

    otf_path = tmp_dir / "smoke_fixture.otf"
    build_cff_font().save(str(otf_path))

    resp = sc.send({"cmd": "inspect", "path": str(otf_path)})
    _require(resp is not None and resp.get("ok") is True, f"inspect 실패: {resp}")
    _require(resp.get("converted_from_otf") is True,
             f"inspect가 CFF 입력을 converted_from_otf=True로 보고하지 않았습니다: {resp}")
    print(f"  inspect OK — converted_from_otf={resp['converted_from_otf']}", flush=True)


def check_quit(sc: SidecarProcess) -> None:
    sc.send({"cmd": "quit"})
    code = sc.close()
    _require(code == 0, f"quit 이후 종료 코드가 0이 아닙니다: {code}")
    print("  quit OK — 프로세스 정상 종료(0)", flush=True)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"사용법: python {Path(argv[0]).name} <exe 경로>", file=sys.stderr)
        return 1
    exe_path = Path(argv[1]).resolve()
    if not exe_path.is_file():
        print(f"오류: exe를 찾을 수 없습니다: {exe_path}", file=sys.stderr)
        return 1
    for label, path in (("font_a", FONT_A), ("font_b", FONT_B)):
        if not path.is_file():
            print(f"오류: 샘플 폰트가 없습니다({label}): {path}", file=sys.stderr)
            return 1

    print(f"[smoke] {exe_path}", flush=True)
    t0 = time.perf_counter()
    sc = None
    try:
        with tempfile.TemporaryDirectory(prefix="moeum-smoke-") as tmp:
            tmp_dir = Path(tmp)
            sc = SidecarProcess(exe_path)
            check_ping(sc)
            check_merge_basic(sc, tmp_dir)
            check_merge_mono(sc, tmp_dir)
            check_inspect(sc, tmp_dir)
            check_quit(sc)
    except SmokeFailure as e:
        print(f"\n스모크 실패: {e}", file=sys.stderr)
        if sc:
            print(f"최근 사이드카 stderr:\n{sc.stderr_tail()}", file=sys.stderr)
            sc.kill()
        return 1
    except Exception as e:  # 예상 못 한 예외도 명확한 메시지로 남긴다
        print(f"\n스모크 실패(예외): {type(e).__name__}: {e}", file=sys.stderr)
        if sc:
            print(f"최근 사이드카 stderr:\n{sc.stderr_tail()}", file=sys.stderr)
            sc.kill()
        return 1

    elapsed = time.perf_counter() - t0
    print(f"\n[smoke] 전부 통과 — {elapsed:.1f}초")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
