"""사이드카 convert(저장 형식 변환) 검증 — 병합 결과 TTF → WOFF2.

sample/의 실제 TTF로 왕복해 글리프·cmap이 보존되는지 본다(WOFF2는 glyf를 재구성하는
변환이라 단순 압축보다 깨질 여지가 있다).

실행: uv run --directory scripts pytest -q
"""

from pathlib import Path

from fontTools.ttLib import TTFont

from sidecar import handle

SAMPLE = Path(__file__).resolve().parent.parent / "sample" / "JetBrainsMono-Regular.ttf"


def test_ttf_to_woff2_roundtrip(tmp_path):
    out = tmp_path / "out.woff2"
    resp = handle({"cmd": "convert", "input": str(SAMPLE), "output": str(out), "flavor": "woff2"})
    assert resp == {"ok": True}

    original = TTFont(str(SAMPLE))
    woff2 = TTFont(str(out), lazy=False)
    woff2.ensureDecompiled(recurse=True)
    assert woff2.flavor == "woff2"
    assert woff2.getGlyphOrder() == original.getGlyphOrder()
    assert woff2.getBestCmap() == original.getBestCmap()
    assert out.stat().st_size < SAMPLE.stat().st_size


def test_unknown_flavor_is_rejected(tmp_path):
    resp = handle({"cmd": "convert", "input": str(SAMPLE), "output": str(tmp_path / "x"),
                   "flavor": "eot"})
    assert resp["ok"] is False
    assert "eot" in resp["error"]
