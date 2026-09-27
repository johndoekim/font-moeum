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
     두 모드 공통 선택 키 "instance_a"/"instance_b": 가변 폰트의 축 좌표
     ({"wght": 700}). 없거나 null이어도 가변 폰트는 축 기본값으로 고정된다.
     두 모드 공통 선택 키 "subset": "none"(기본) | "no_hanja" | "ksx1001" — 병합 후
     한글 음절·한자만 덜어낸다(subset_presets.py). none이 아니면 stats에
     "subset": {preset, codepoints_removed, glyphs_before, glyphs_after,
     bytes_before, bytes_after}가 붙는다.

  → {"cmd": "merge", "mode": "mono", "font_a": "...", "font_b": "...", "output": "...",
     "name": "MoeumMono", "style": "Regular", "korean_scale": 1.15, "width_mult": 2.0,
     "ty": 0.0, "include_hanja": true, "fullwidth_source": "B", "jamo_ccmp": true}
  ← {"ok": true, "path": "...", "elapsed": 1.9,
     "stats": {"mode": "mono", "copied": 123, "capped": 0, "glyphs_added": 123,
               "latin_advance": 600, "korean_advance": 1200, "upem": 1000,
               "hanja_copied": 4888, "ccmp_rules": 40, "warnings": []}}

  → {"cmd": "inspect", "path": "..."}
  ← {"ok": true, "monospace": true, "converted_from_otf": false, "variable": null}
     (converted_from_otf: OTF(CFF/가변 CFF2) 입력 — 병합 시 TTF로 변환됨을 UI 배지로
      알림. variable: 가변 폰트면 {"axes": [{tag, name, min, default, max}],
      "instances": [{name, coordinates}]}, 정적이면 null. 최초 inspect가 OTF 변환·
      기본값 인스턴스를 디스크 캐시로 선지불한다. 열기 실패는 {"ok": false, "error": "..."})

  → {"cmd": "convert", "input": "...", "output": "...", "flavor": "woff2"}
  ← {"ok": true}
     (저장 시점 형식 변환 — 병합 결과는 항상 TTF이고 WOFF2는 내보낼 때만 만든다.
      brotli가 없으면(번들 누락) fontTools가 ImportError → {"ok": false, "error": "..."})

  → {"cmd": "quit"}                                (응답 없이 종료; stdin EOF도 동일)
"""

import json
import sys
import time
from pathlib import Path

from fontTools import version as fonttools_version
from fontTools.ttLib import TTFont

from fitmerge import check_monospace, fit_merge_to_file
from merge import (MergeError, load_ttf, merge_to_file, needs_conversion, resolve_instance,
                   variable_info)
from subset_presets import subset_file


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
        instance_a=req.get("instance_a"),
        instance_b=req.get("instance_b"),
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
        instance_a=req.get("instance_a"),
        instance_b=req.get("instance_b"),
    )
    path = result.pop("path")
    stats = {"mode": "mono", **result}
    return {"path": path, "stats": stats}


def _inspect(req: dict) -> dict:
    """폰트 고정폭 여부 + OTF 변환 여부 + 가변 축 판정 — UI 배지와 mono 엔진 하드 에러
    (check_monospace)가 같은 코드를 쓰는 단일 진실원. OTF 변환과 가변 폰트의 기본값
    인스턴스(대형 한글 가변 폰트는 수 초)를 여기서 디스크 캐시로 선지불해 첫 병합을
    가볍게 한다. 열기 실패(MergeError)는 호출자에서 ok:false로 변환."""
    path = Path(req["path"])
    converted = needs_conversion(path)
    variable = variable_info(path)
    font = load_ttf(resolve_instance(path))
    try:
        check_monospace(font)
        monospace = True
    except MergeError:
        monospace = False
    return {"ok": True, "monospace": monospace, "converted_from_otf": converted,
            "variable": variable}


def _convert(req: dict) -> dict:
    """병합 결과 TTF를 저장용 형식으로 변환해 output에 쓴다 — 현재는 WOFF2(웹폰트)만."""
    flavor = req.get("flavor")
    if flavor != "woff2":
        return {"ok": False, "error": f"지원하지 않는 저장 형식: {flavor}"}
    font = TTFont(req["input"])
    font.flavor = "woff2"
    font.save(req["output"])
    return {"ok": True}


def handle(req: dict):
    cmd = req.get("cmd")
    if cmd == "ping":
        return {"ok": True, "fonttools": fonttools_version}
    if cmd == "inspect":
        return _inspect(req)
    if cmd == "convert":
        return _convert(req)
    if cmd == "merge":
        mode = req.get("mode", "basic")
        t0 = time.perf_counter()
        if mode == "basic":
            result = _merge_basic(req)
        elif mode == "mono":
            result = _merge_mono(req)
        else:
            return {"ok": False, "error": f"알 수 없는 병합 모드: {mode}"}
        subset_stats = subset_file(result["path"], req.get("subset") or "none")
        if subset_stats:
            result["stats"]["subset"] = subset_stats
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
