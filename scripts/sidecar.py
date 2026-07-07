"""font-moa persistent 사이드카.

앱 시작 시 1회 기동되어 stdin에서 JSON 라인 명령을 읽고 stdout으로 JSON 라인을
응답한다. fonttools import(콜드 스타트 비용)는 프로세스 기동 시 한 번만 지불.

프로토콜 (한 줄 = 한 메시지, UTF-8):
  → {"cmd": "ping"}
  ← {"ok": true, "fonttools": "4.63.0"}
  → {"cmd": "merge", "font_a": "...", "font_b": "...", "output": "...",
     "name": "MoaMerged", "base": "A"}
  ← {"ok": true, "path": "...", "elapsed": 2.8}   (실패 시 {"ok": false, "error": "..."})
  → {"cmd": "quit"}                                (응답 없이 종료; stdin EOF도 동일)
"""

import json
import sys
import time

from fontTools import version as fonttools_version

from merge import MergeError, merge_to_file

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def handle(req: dict):
    cmd = req.get("cmd")
    if cmd == "ping":
        return {"ok": True, "fonttools": fonttools_version}
    if cmd == "merge":
        t0 = time.perf_counter()
        out = merge_to_file(
            req["font_a"], req["font_b"], req["output"],
            name=req.get("name", "MoaMerged"),
            base=req.get("base", "A"),
            upem=req.get("upem"),
        )
        return {"ok": True, "path": str(out), "elapsed": round(time.perf_counter() - t0, 2)}
    if cmd == "quit":
        return None
    return {"ok": False, "error": f"알 수 없는 명령: {cmd}"}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            resp = handle(json.loads(line))
        except MergeError as e:
            resp = {"ok": False, "error": str(e)}
        except Exception as e:  # 프로토콜 오류/예상 못 한 예외에도 프로세스는 살아있어야 함
            resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        if resp is None:
            break
        print(json.dumps(resp, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
