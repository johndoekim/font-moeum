"""otf2ttf 변환 검증 — in-memory CFF 픽스처로 테이블·아웃라인·메트릭 불변식을 고정한다.

실제 폰트 파일 없이 FontBuilder로 최소 CFF(OTF)를 만들어 검증하므로 저장소에
바이너리 픽스처를 넣지 않는다. 병합 엔진 자체는 기존대로 CLI 수동 검증(TODO.md Phase 7).

실행: uv run --directory scripts pytest -q
"""

import io
import os

import pytest
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

from merge import MergeError, is_cff_flavored, load_ttf
from otf2ttf import otf_to_ttf

UPEM = 1000
ADVANCE = 600


def build_cff_font() -> TTFont:
    """진짜 3차 곡선(curveTo)을 가진 글리프를 포함하는 최소 CFF OTF."""
    glyph_order = [".notdef", "space", "A"]
    fb = FontBuilder(UPEM, isTTF=False)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap({0x20: "space", 0x41: "A"})

    pen = T2CharStringPen(ADVANCE, None)
    pen.moveTo((100, 0))
    pen.lineTo((100, 700))
    pen.curveTo((200, 800), (400, 800), (500, 700))  # 3차 곡선 — 변환 대상
    pen.lineTo((500, 0))
    pen.closePath()
    charstrings = {"A": pen.getCharString()}
    for name in (".notdef", "space"):
        charstrings[name] = T2CharStringPen(ADVANCE, None).getCharString()

    fb.setupCFF("TestCFF-Regular", {}, charstrings, {})
    fb.setupHorizontalMetrics({name: (ADVANCE, 100 if name == "A" else 0) for name in glyph_order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "TestCFF", "styleName": "Regular"})
    fb.setupOS2()
    fb.setupPost()
    return fb.font


def convert_and_reload(font: TTFont) -> TTFont:
    """변환 후 저장→재로드 왕복 — 컴파일 단계까지 통과해야 진짜 유효한 TTF다."""
    otf_to_ttf(font)
    buf = io.BytesIO()
    font.save(buf)
    buf.seek(0)
    return TTFont(buf)


def test_tables_and_flavor():
    font = build_cff_font()
    otf_to_ttf(font)
    assert "glyf" in font and "loca" in font
    assert "CFF " not in font
    assert font.sfntVersion == "\x00\x01\x00\x00"
    assert font["maxp"].tableVersion == 0x00010000
    assert font["post"].formatType == 2.0  # 글리프 이름 보존 (캐시 파일 디버깅 편의)
    assert font["head"].unitsPerEm == UPEM


def test_outlines_are_quadratic():
    reloaded = convert_and_reload(build_cff_font())
    rec = RecordingPen()
    reloaded.getGlyphSet()["A"].draw(rec)
    ops = [op for op, _ in rec.value]
    assert "curveTo" not in ops  # 3차 곡선이 남아 있으면 변환 실패
    assert "qCurveTo" in ops     # 곡선이 통째로 사라져도 실패
    assert ops.count("moveTo") == 1


def test_metrics_and_cmap_preserved():
    reloaded = convert_and_reload(build_cff_font())
    assert reloaded["hmtx"]["A"] == (ADVANCE, 100)
    assert reloaded["hmtx"]["space"][0] == ADVANCE
    assert reloaded.getBestCmap()[0x41] == "A"
    assert reloaded.getGlyphOrder() == [".notdef", "space", "A"]


# ── load_ttf 통합 (7b): 변환 훅 · 디스크 캐시 · CFF2 거부 ──────────────────────


def build_cff2_font() -> TTFont:
    """CFF2(가변 계열) 최소 폰트 — 거부 대상."""
    glyph_order = [".notdef", "A"]
    fb = FontBuilder(UPEM, isTTF=False)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap({0x41: "A"})
    pen = T2CharStringPen(None, None, CFF2=True)  # CFF2는 charstring에 width 인코딩 불가
    pen.moveTo((100, 0))
    pen.lineTo((100, 700))
    pen.lineTo((500, 700))
    pen.closePath()
    charstrings = {
        "A": pen.getCharString(),
        ".notdef": T2CharStringPen(None, None, CFF2=True).getCharString(),
    }
    fb.setupCFF2(charstrings)
    fb.setupHorizontalMetrics({name: (ADVANCE, 0) for name in glyph_order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "TestCFF2", "styleName": "Regular"})
    fb.setupOS2()
    fb.setupPost()
    return fb.font


def build_ttf_marker_font() -> TTFont:
    """글리프 'Z'를 가진 TTF — 캐시 히트를 관측하는 마커."""
    glyph_order = [".notdef", "Z"]
    fb = FontBuilder(UPEM, isTTF=True)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap({0x5A: "Z"})
    pen = TTGlyphPen(None)
    pen.moveTo((0, 0))
    pen.lineTo((0, 500))
    pen.lineTo((300, 500))
    pen.closePath()
    fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "Z": pen.glyph()})
    fb.setupHorizontalMetrics({name: (ADVANCE, 0) for name in glyph_order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "Marker", "styleName": "Regular"})
    fb.setupOS2()
    fb.setupPost()
    return fb.font


def _bump_mtime(path, newer_than) -> None:
    """path의 mtime을 newer_than보다 1초 뒤로 — 신선도 규칙을 결정적으로 검증."""
    ref = newer_than.stat()
    os.utime(path, ns=(ref.st_atime_ns, ref.st_mtime_ns + 1_000_000_000))


def test_load_ttf_converts_otf_and_writes_cache(tmp_path):
    src = tmp_path / "upload_0.ttf"  # 확장자 무관 — 내용 기준 판정
    build_cff_font().save(str(src))
    font = load_ttf(src)
    assert "glyf" in font and "CFF " not in font
    assert (tmp_path / "upload_0.ttf.ttfcache").is_file()


def test_load_ttf_uses_fresh_cache(tmp_path):
    src = tmp_path / "font.otf"
    build_cff_font().save(str(src))
    load_ttf(src)  # 캐시 생성
    cache = tmp_path / "font.otf.ttfcache"
    build_ttf_marker_font().save(str(cache))  # 캐시를 마커로 교체
    _bump_mtime(cache, newer_than=src)
    assert "Z" in load_ttf(src).getGlyphOrder()  # 마커가 보이면 캐시에서 로드된 것


def test_load_ttf_reconverts_stale_cache(tmp_path):
    # 세션 간 upload_N 경로 재사용 시나리오: 원본이 캐시보다 최신이면 재변환해야 한다
    src = tmp_path / "font.otf"
    build_cff_font().save(str(src))
    load_ttf(src)
    cache = tmp_path / "font.otf.ttfcache"
    build_ttf_marker_font().save(str(cache))
    _bump_mtime(src, newer_than=cache)
    order = load_ttf(src).getGlyphOrder()
    assert "Z" not in order and "A" in order


def test_load_ttf_recovers_from_corrupt_cache(tmp_path):
    src = tmp_path / "font.otf"
    build_cff_font().save(str(src))
    load_ttf(src)
    cache = tmp_path / "font.otf.ttfcache"
    cache.write_bytes(b"garbage")
    _bump_mtime(cache, newer_than=src)
    font = load_ttf(src)  # 조용히 재변환해야 한다
    assert "glyf" in font and "A" in font.getGlyphOrder()


def test_load_ttf_rejects_cff2(tmp_path):
    src = tmp_path / "var.otf"
    build_cff2_font().save(str(src))
    with pytest.raises(MergeError, match="CFF2"):
        load_ttf(src)


def test_inspect_reports_otf_conversion(tmp_path):
    """사이드카 inspect가 배지용 converted_from_otf 필드를 실어 보낸다."""
    from sidecar import _inspect

    otf = tmp_path / "a.otf"
    build_cff_font().save(str(otf))
    resp = _inspect({"path": str(otf)})
    assert resp["ok"] is True
    assert resp["converted_from_otf"] is True

    ttf = tmp_path / "b.ttf"
    build_ttf_marker_font().save(str(ttf))
    assert _inspect({"path": str(ttf)})["converted_from_otf"] is False


def test_is_cff_flavored(tmp_path):
    otf = tmp_path / "a.otf"
    build_cff_font().save(str(otf))
    ttf = tmp_path / "b.ttf"
    build_ttf_marker_font().save(str(ttf))
    assert is_cff_flavored(otf) is True
    assert is_cff_flavored(ttf) is False
