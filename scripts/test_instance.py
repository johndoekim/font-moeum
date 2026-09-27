"""가변 폰트 → 정적 인스턴스 고정(resolve_instance) 검증 — in-memory 가변 TTF 픽스처.

회귀 대상(실측, JetBrainsMono[wght] + PretendardVariable):
- basic: Merger가 HVAR의 VarStore에서 죽는다 ("type object 'VarStore' has no attribute 'mergeMap'")
- mono: A의 gvar가 옛 글리프 수로 남아 fontTools조차 다시 못 여는 파일이 "성공"으로 나온다

실행: uv run --directory scripts pytest -q
"""

import os
from pathlib import Path

import pytest
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables import otTables
from fontTools.ttLib.tables.TupleVariation import TupleVariation
from fontTools.varLib.hvar import add_HVAR
from fontTools.varLib.varStore import OnlineVarStoreBuilder

from fitmerge import fit_merge_to_file
from merge import MergeError, load_ttf, merge_to_file, parse_location, resolve_instance, variable_info

UPEM = 1000
ADVANCE = 600
# check_monospace가 advance를 비교하는 샘플(" A0Hinmw")을 모두 갖춰야 mono 엔진 A가 된다
LATIN = " A0Hinmw"
STEM_DELTA = 200  # wght 최대(900)에서 사각형 오른쪽 변이 이만큼 두꺼워진다


def _rect_glyph(x0, y0, x1, y1):
    pen = TTGlyphPen(None)
    pen.moveTo((x0, y0))
    pen.lineTo((x0, y1))
    pen.lineTo((x1, y1))
    pen.lineTo((x1, y0))
    pen.closePath()
    return pen.glyph()


def _glyph_name(ch: str) -> str:
    return "space" if ch == " " else f"uni{ord(ch):04X}"


def build_font(chars: str, advance: int, *, variable: bool, family: str) -> TTFont:
    """chars의 각 글자에 사각형 글리프를 둔 최소 TTF. variable=True면 wght 100–900(기본 400)
    축과 gvar(최대 굵기에서 오른쪽 두 점을 STEM_DELTA만큼 이동) + HVAR를 붙인다."""
    names = [_glyph_name(c) for c in chars]
    glyph_order = [".notdef"] + names
    fb = FontBuilder(UPEM, isTTF=True)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap({ord(c): n for c, n in zip(chars, names)})
    glyphs = {".notdef": _rect_glyph(50, 0, advance - 50, 700)}
    for c, n in zip(chars, names):
        glyphs[n] = TTGlyphPen(None).glyph() if c == " " else _rect_glyph(100, 0, advance - 100, 700)
    fb.setupGlyf(glyphs)
    # lsb = xMin이어야 glyphset이 윤곽을 원위치에 그린다(어긋나면 lsb 기준으로 평행이동)
    glyf = fb.font["glyf"]
    fb.setupHorizontalMetrics({n: (advance, getattr(glyf[n], "xMin", 0)) for n in glyph_order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": family, "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    if variable:
        fb.setupFvar(
            axes=[("wght", 100, 400, 900, "Weight")],
            instances=[
                {"location": {"wght": 100}, "stylename": "Thin"},
                {"location": {"wght": 400}, "stylename": "Regular"},
                {"location": {"wght": 900}, "stylename": "Black"},
            ],
        )
        variations = {}
        for c, n in zip(chars, names):
            if c == " ":
                continue
            # 점 순서: (x0,y0) (x0,y1) (x1,y1) (x1,y0) + 팬텀 4점
            deltas = [(0, 0), (0, 0), (STEM_DELTA, 0), (STEM_DELTA, 0)] + [(0, 0)] * 4
            variations[n] = [TupleVariation({"wght": (0.0, 1.0, 1.0)}, deltas)]
        fb.setupGvar(variations)
        add_HVAR(fb.font)
        _add_gdef_varstore(fb.font)
    return fb.font


def _add_gdef_varstore(font: TTFont) -> None:
    """GDEF 1.3 + VarStore — JetBrainsMono[wght]처럼 가변 커닝·앵커를 가진 폰트의 모양.
    Merger가 실제로 죽던 지점("type object 'VarStore' has no attribute 'mergeMap'")."""
    builder = OnlineVarStoreBuilder(["wght"])
    builder.setSupports([{"wght": (0.0, 1.0, 1.0)}])
    builder.storeDeltas([10])
    gdef = otTables.GDEF()
    gdef.Version = 0x00010003
    for attr in ("GlyphClassDef", "AttachList", "LigCaretList", "MarkAttachClassDef",
                 "MarkGlyphSetsDef"):
        setattr(gdef, attr, None)
    gdef.VarStore = builder.finish()
    font["GDEF"] = newTable("GDEF")
    font["GDEF"].table = gdef


def _save(font: TTFont, path: Path) -> Path:
    font.save(str(path))
    return path


@pytest.fixture
def var_latin(tmp_path):
    return _save(build_font(LATIN, ADVANCE, variable=True, family="VarLatin"), tmp_path / "varlatin.ttf")


@pytest.fixture
def static_hangul(tmp_path):
    return _save(build_font(" 가나", 1000, variable=False, family="Hangul"), tmp_path / "hangul.ttf")


def _xmax(path, ch="A") -> float:
    font = TTFont(str(path))
    gs = font.getGlyphSet()
    pen = BoundsPen(gs)
    gs[font.getBestCmap()[ord(ch)]].draw(pen)
    return pen.bounds[2]


def test_static_font_passes_through(static_hangul):
    assert resolve_instance(static_hangul) == static_hangul
    assert variable_info(static_hangul) is None


def test_variable_info_lists_axes_and_named_instances(var_latin):
    info = variable_info(var_latin)
    assert info["axes"] == [{"tag": "wght", "name": "Weight", "min": 100.0, "default": 400.0, "max": 900.0}]
    assert [i["name"] for i in info["instances"]] == ["Thin", "Regular", "Black"]
    assert info["instances"][2]["coordinates"] == {"wght": 900.0}


def test_variable_is_always_pinned_even_without_location(var_latin):
    """location이 없어도 가변 테이블을 남기지 않는다 — 그대로 엔진에 넘기면 깨진다."""
    out = resolve_instance(var_latin)
    assert out != var_latin
    font = TTFont(str(out))
    for tag in ("fvar", "gvar", "HVAR"):
        assert tag not in font
    assert _xmax(out) == ADVANCE - 100  # 기본(400) = 델타 없음


def test_location_changes_outline_and_path(var_latin):
    regular = resolve_instance(var_latin)
    black = resolve_instance(var_latin, {"wght": 900})
    assert black != regular
    assert _xmax(black) == ADVANCE - 100 + STEM_DELTA


def test_same_location_hits_cache(var_latin):
    first = resolve_instance(var_latin, {"wght": 900})
    mtime = os.stat(first).st_mtime_ns
    again = resolve_instance(var_latin, {"wght": 900})
    assert again == first
    assert os.stat(again).st_mtime_ns == mtime  # 다시 쓰지 않았다


def test_out_of_range_is_clamped(var_latin):
    assert resolve_instance(var_latin, {"wght": 5000}) == resolve_instance(var_latin, {"wght": 900})


def test_replaced_source_evicts_stale_instances(var_latin):
    """같은 경로에 다른 내용(세션마다 재사용되는 upload_N)이 오면 옛 인스턴스는 청소된다."""
    old = resolve_instance(var_latin, {"wght": 900})
    _save(build_font(LATIN, ADVANCE + 10, variable=True, family="VarLatin2"), var_latin)
    new = resolve_instance(var_latin, {"wght": 900})
    assert new != old
    assert not os.path.exists(old)


def test_load_ttf_refuses_unpinned_variable(var_latin):
    with pytest.raises(MergeError):
        load_ttf(var_latin)


def test_parse_location():
    assert parse_location("wght=700, wdth=87.5") == {"wght": 700.0, "wdth": 87.5}
    with pytest.raises(ValueError):
        parse_location("wght")


def test_basic_merge_with_variable_input(var_latin, static_hangul, tmp_path):
    """회귀: GDEF VarStore를 가진 가변 A → Merger 크래시, 그리고 요청한 굵기가 실제로 반영되는지."""
    out = merge_to_file(var_latin, static_hangul, tmp_path / "basic.ttf",
                        name="VarBasic", instance_a={"wght": 900})
    font = TTFont(str(out), lazy=False)
    font.ensureDecompiled(recurse=True)
    assert "fvar" not in font and "gvar" not in font
    assert _xmax(out) == ADVANCE - 100 + STEM_DELTA


def test_mono_merge_with_variable_base(var_latin, static_hangul, tmp_path):
    """회귀: 가변 A의 gvar가 옛 글리프 수로 남아 다시 열 수 없는 파일이 나오던 문제."""
    result = fit_merge_to_file(var_latin, static_hangul, tmp_path / "mono.ttf",
                               name="VarMono", instance_a={"wght": 900})
    font = TTFont(result["path"], lazy=False)
    font.ensureDecompiled(recurse=True)  # 옛 동작에선 gvar 디컴파일 AssertionError
    assert "fvar" not in font and "gvar" not in font
    assert ord("가") in font.getBestCmap()
