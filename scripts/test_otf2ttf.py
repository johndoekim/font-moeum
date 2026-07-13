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

from merge import MergeError, load_ttf, needs_conversion
from otf2ttf import otf_to_ttf

UPEM = 1000
ADVANCE = 600


def build_cff_font(letter: str = "A") -> TTFont:
    """진짜 3차 곡선(curveTo)을 가진 글리프를 포함하는 최소 CFF OTF."""
    glyph_order = [".notdef", "space", letter]
    fb = FontBuilder(UPEM, isTTF=False)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap({0x20: "space", ord(letter): letter})

    pen = T2CharStringPen(ADVANCE, None)
    pen.moveTo((100, 0))
    pen.lineTo((100, 700))
    pen.curveTo((200, 800), (400, 800), (500, 700))  # 3차 곡선 — 변환 대상
    pen.lineTo((500, 0))
    pen.closePath()
    charstrings = {letter: pen.getCharString()}
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
    assert font["maxp"].maxZones == 1  # 스펙상 1|2만 유효 — 0은 검증기가 플래그
    assert font["post"].formatType == 2.0  # 글리프 이름 보존 (캐시 파일 디버깅 편의)
    assert font["head"].unitsPerEm == UPEM


def test_post_falls_back_to_format3_on_huge_glyph_count():
    """비표준 이름 65,279개 초과(풀버전 Pan-CJK CID OTF)는 post 2.0 인코딩(uint16) 불가 —
    업스트림 스니펫과 동일하게 3.0으로 낙하해야 저장이 죽지 않는다."""
    n = 65_300
    glyph_order = [".notdef"] + [f"cid{i:05d}" for i in range(1, n)]
    fb = FontBuilder(UPEM, isTTF=False)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap({0x41: "cid00001"})
    empty = T2CharStringPen(ADVANCE, None).getCharString()
    fb.setupCFF("Huge-Regular", {}, {name: empty for name in glyph_order}, {})
    fb.setupHorizontalMetrics({name: (ADVANCE, 0) for name in glyph_order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "Huge", "styleName": "Regular"})
    fb.setupOS2()
    fb.setupPost()
    font = fb.font
    otf_to_ttf(font)
    assert font["post"].formatType == 3.0


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


def test_load_ttf_reconverts_replaced_source_with_older_mtime(tmp_path):
    """zip 해제·cp -p 등은 과거 mtime을 보존한다 — mtime 단독 비교면 낡은 캐시가 이긴다.
    신원은 fitmerge B-분석 캐시와 같은 (size, mtime_ns) 기준이어야 한다."""
    src = tmp_path / "font.otf"
    build_cff_font("A").save(str(src))
    load_ttf(src)  # 캐시 생성 (글리프 A)
    old = src.stat()
    build_cff_font("B").save(str(src))  # 같은 경로를 다른 내용으로 교체
    os.utime(src, ns=(old.st_atime_ns, old.st_mtime_ns - 3_600_000_000_000))  # 1시간 과거
    order = load_ttf(src).getGlyphOrder()
    assert "B" in order and "A" not in order


def test_load_ttf_glyf_cff_coexistence_prefers_glyf(tmp_path):
    """비정상 폰트(glyf+CFF 공존)는 glyf를 그대로 쓰고 CFF만 제거 — 변환·캐시 없음."""
    hybrid = build_ttf_marker_font()
    hybrid["CFF "] = build_cff_font()["CFF "]
    src = tmp_path / "hybrid.otf"
    hybrid.save(str(src))
    loaded = load_ttf(src)
    assert "glyf" in loaded and "CFF " not in loaded
    assert "Z" in loaded.getGlyphOrder()
    assert not (tmp_path / "hybrid.otf.ttfcache").exists()


def test_load_ttf_rejects_unknown_outline_format(tmp_path):
    font = build_ttf_marker_font()
    buf = io.BytesIO()
    font.save(buf)
    buf.seek(0)
    stripped = TTFont(buf)
    del stripped["glyf"]
    del stripped["loca"]
    src = tmp_path / "weird.ttf"
    stripped.save(str(src))
    with pytest.raises(MergeError, match="알 수 없는 형식"):
        load_ttf(src)


def test_load_ttf_proceeds_uncached_on_cache_write_failure(tmp_path, monkeypatch):
    """캐시 저장 실패는 로드를 죽이지 않고, tmp 잔류물도 남기지 않아야 한다."""
    import merge as merge_mod

    def boom(_src, _dst):
        raise OSError("disk full")

    monkeypatch.setattr(merge_mod.os, "replace", boom)
    src = tmp_path / "font.otf"
    build_cff_font().save(str(src))
    font = load_ttf(src)
    assert "glyf" in font and "A" in font.getGlyphOrder()
    assert list(tmp_path.glob("*.ttfcache*")) == []  # 캐시도 tmp도 없어야 함


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


def test_needs_conversion_matches_actual_behavior(tmp_path):
    """배지 판정은 load_ttf와 같은 기준(테이블 존재)이어야 한다 — sfnt 태그가 아니라."""
    otf = tmp_path / "a.otf"
    build_cff_font().save(str(otf))
    ttf = tmp_path / "b.ttf"
    build_ttf_marker_font().save(str(ttf))
    assert needs_conversion(otf) is True
    assert needs_conversion(ttf) is False
    # TrueType 태그를 단 CFF-only 폰트: 실제로 변환되므로 True여야 한다
    mislabeled = build_cff_font()
    mislabeled.sfntVersion = "\x00\x01\x00\x00"
    mp = tmp_path / "mislabeled.ttf"
    mislabeled.save(str(mp))
    assert needs_conversion(mp) is True
    # glyf+CFF 공존: glyf 우선이라 변환 없음 → False여야 한다
    hybrid = build_ttf_marker_font()
    hybrid["CFF "] = build_cff_font()["CFF "]
    hp = tmp_path / "hybrid.otf"
    hybrid.save(str(hp))
    assert needs_conversion(hp) is False
