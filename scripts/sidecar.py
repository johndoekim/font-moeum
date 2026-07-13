"""font-moeum persistent 사이드카.

앱 시작 시 1회 기동되어 stdin에서 JSON 라인 명령을 읽고 stdout으로 JSON 라인을
응답한다. fonttools import(콜드 스타트 비용)는 프로세스 기동 시 한 번만 지불.

프로토콜 (한 줄 = 한 메시지, UTF-8):
  → {"cmd": "ping"}
  ← {"ok": true, "fonttools": "4.63.0"}

  → {"cmd": "merge", "mode": "basic", "font_a": "...", "font_b": "...", "output": "...",
     "name": "MoeumMerged", "base": "A", "cjk_source": "B", "upem": null, "style": "Regular"}
  ← {"ok": true, "path": "...", "elapsed": 2.8, "stats": {"mode": "basic"}}
     (mode 없으면 "basic"과 동일 — 하위호환. cjk_source 없거나 null이면 base를 따름
      — 기존 동작. 실패 시 {"ok": false, "error": "..."})

  → {"cmd": "merge", "mode": "mono", "font_a": "...", "font_b": "...", "output": "...",
     "name": "MoeumMono", "style": "Regular", "korean_scale": 1.15, "width_mult": 2.0,
     "ty": 0.0, "include_hanja": true, "fullwidth_source": "B", "jamo_ccmp": true}
  ← {"ok": true, "path": "...", "elapsed": 1.9,
     "stats": {"mode": "mono", "copied": 123, "capped": 0, "glyphs_added": 123,
               "latin_advance": 600, "korean_advance": 1200, "upem": 1000,
               "hanja_copied": 4888, "ccmp_rules": 40, "warnings": []}}

  → {"cmd": "inspect", "path": "..."}
  ← {"ok": true, "monospace": true, "converted_from_otf": false}
     (converted_from_otf: 정적 OTF(CFF) 입력 — 병합 시 TTF로 변환됨을 UI 배지로 알림.
      최초 inspect가 변환+디스크 캐시를 선지불한다. 가변 OTF(CFF2)·열기 실패는
      {"ok": false, "error": "..."})

  → {"cmd": "quit"}                                (응답 없이 종료; stdin EOF도 동일)
"""

import json
import sys
import time
from pathlib import Path

from fontTools import version as fonttools_version

from fitmerge import check_monospace, fit_merge_to_file
from merge import MergeError, load_ttf, merge_to_file, needs_conversion


# pytest 등이 스트림을 교체하면 reconfigure가 없을 수 있다 — 실제 사이드카
# 기동(파이프 stdio)에서는 항상 존재.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")


def _merge_basic(req: dict) -> dict:
    out = merge_to_file(
        req["font_a"], req["font_b"], req["output"],
        name=req.get("name", "MoeumMerged"),
        base=req.get("base", "A"),
        cjk_source=req.get("cjk_source"),
        upem=req.get("upem"),
        style=req.get("style", "Regular"),
    )
    return {"path": str(out), "stats": {"mode": "basic"}}


def _merge_mono(req: dict) -> dict:
    result = fit_merge_to_file(
        req["font_a"], req["font_b"], req["output"],
        name=req.get("name", "MoeumMono"),
        style=req.get("style", "Regular"),
        korean_scale=req.get("korean_scale", 1.15),
        width_mult=req.get("width_mult", 2.0),
        ty=req.get("ty", 0.0),
        include_hanja=req.get("include_hanja", True),
        fullwidth_source=req.get("fullwidth_source", "B"),
        jamo_ccmp=req.get("jamo_ccmp", True),
    )
    path = result.pop("path")
    stats = {"mode": "mono", **result}
    return {"path": path, "stats": stats}


def _inspect(req: dict) -> dict:
    """폰트 고정폭 여부 + OTF 변환 여부 판정 — UI 배지와 mono 엔진 하드 에러
    (check_monospace)가 같은 코드를 쓰는 단일 진실원. OTF면 load_ttf가 여기서
    변환+캐시를 선지불한다. 열기 실패(MergeError)는 호출자에서 ok:false로 변환."""
    path = Path(req["path"])
    converted = needs_conversion(path)
    font = load_ttf(path)
    try:
        check_monospace(font)
        monospace = True
    except MergeError:
        monospace = False
    return {"ok": True, "monospace": monospace, "converted_from_otf": converted}


def handle(req: dict):
    cmd = req.get("cmd")
    if cmd == "ping":
        return {"ok": True, "fonttools": fonttools_version}
    if cmd == "inspect":
        return _inspect(req)
    if cmd == "merge":
        mode = req.get("mode", "basic")
        t0 = time.perf_counter()
        if mode == "basic":
            result = _merge_basic(req)
        elif mode == "mono":
            result = _merge_mono(req)
        else:
            return {"ok": False, "error": f"알 수 없는 병합 모드: {mode}"}
        return {
            "ok": True,
            "path": result["path"],
            "elapsed": round(time.perf_counter() - t0, 2),
            "stats": result["stats"],
        }
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
