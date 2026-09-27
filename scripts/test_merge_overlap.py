"""일반 모드(merge.py) 겹치는 코드포인트 담당 검증 — 셰이핑 단계에서도 담당 폰트가 이기는지.

회귀 대상(실측, JetBrains Mono + Pretendard): Merger는 두 폰트가 같은 코드포인트를 서로
다른 글리프로 가지면 뒤 폰트의 스크립트(latn 등, DFLT 제외)에 합성 locl(앞 글리프 → 뒤
글리프)을 만든다. cmap은 라틴 담당(A)을 가리켜도 브라우저·CoreText가 라틴을 셰이핑하면
locl이 B 글리프로 바꿔 "라틴 담당 A"가 뒤집혔다. GSUB가 없는 D2Coding 샘플로는 이 합성이
일어나지 않아 잡히지 않았다 — 여기서는 latn 스크립트 GSUB를 가진 B 픽스처로 재현한다.

실행: uv run --directory scripts pytest -q
"""

from pathlib import Path

import pytest
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables import otTables

from merge import merge_to_file

UPEM = 1000


def _rect(x0, x1):
    pen = TTGlyphPen(None)
    pen.moveTo((x0, 0))
    pen.lineTo((x0, 700))
    pen.lineTo((x1, 700))
    pen.lineTo((x1, 0))
    pen.closePath()
    return pen.glyph()


def build_font(path: Path, family: str, glyphs: dict, cmap: dict, fea: str | None = None) -> Path:
    """glyphs: 이름 → (xMin, xMax, advance). fea가 있으면 feaLib으로 GSUB를 붙인다."""
    order = [".notdef", *glyphs]
    fb = FontBuilder(UPEM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf({".notdef": _rect(50, 450), **{n: _rect(x0, x1) for n, (x0, x1, _) in glyphs.items()}})
    fb.setupHorizontalMetrics({".notdef": (500, 50), **{n: (adv, x0) for n, (x0, _, adv) in glyphs.items()}})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": family, "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    if fea:
        addOpenTypeFeaturesFromString(fb.font, fea)
    fb.font.save(str(path))
    return path


@pytest.fixture
def latin_font(tmp_path):
    """A 역할 — 라틴 'A'(고정폭 600), latn 스크립트가 있는 GSUB(JetBrains Mono의 calt처럼)."""
    return build_font(
        tmp_path / "latin.ttf", "Latin",
        {"A": (100, 500, 600), "A.alt": (110, 490, 600)}, {ord("A"): "A"},
        fea="languagesystem DFLT dflt; languagesystem latn dflt;\n"
            "feature ss02 { sub A by A.alt; } ss02;",
    )


@pytest.fixture
def hangul_font(tmp_path):
    """B 역할 — 다른 모양의 'A' + '가', latn 스크립트가 있는 GSUB(Pretendard처럼)."""
    return build_font(
        tmp_path / "hangul.ttf", "Hangul",
        {"A": (50, 650, 700), "A.ss01": (60, 640, 700), "uniAC00": (50, 950, 1000)},
        {ord("A"): "A", 0xAC00: "uniAC00"},
        fea="languagesystem DFLT dflt; languagesystem latn dflt;\n"
            "feature ss01 { sub A by A.ss01; } ss01;",
    )


def _locl_substituted(font: TTFont) -> set[str]:
    """locl feature가 치환하는 입력 글리프 전체."""
    if "GSUB" not in font:
        return set()
    gsub = font["GSUB"].table
    lookups = {i for fr in gsub.FeatureList.FeatureRecord if fr.FeatureTag == "locl"
               for i in fr.Feature.LookupListIndex}
    hit = set()
    for i in lookups:
        for st in gsub.LookupList.Lookup[i].SubTable:
            st = getattr(st, "ExtSubTable", st)
            if isinstance(st, otTables.SingleSubst):
                hit |= set(st.mapping)
    return hit


@pytest.mark.parametrize("base", ["A", "B"])
def test_latin_owner_is_not_overridden_by_locl(latin_font, hangul_font, tmp_path, base):
    out = merge_to_file(latin_font, hangul_font, tmp_path / "out.ttf", name="Overlap", base=base)
    font = TTFont(str(out))
    cmap = font.getBestCmap()
    owner_glyph = cmap[ord("A")]
    # cmap이 담당 폰트의 글리프를 가리키고(폭으로 판별: A=600, B=700)…
    assert font["hmtx"][owner_glyph][0] == (600 if base == "A" else 700)
    # …셰이핑의 locl이 그 글리프를 다른 폰트 것으로 바꾸지 않는다
    assert owner_glyph not in _locl_substituted(font)


def test_non_overlapping_glyphs_and_b_features_survive(latin_font, hangul_font, tmp_path):
    out = merge_to_file(latin_font, hangul_font, tmp_path / "out.ttf", name="Overlap")
    font = TTFont(str(out))
    cmap = font.getBestCmap()
    assert font["hmtx"][cmap[0xAC00]][0] == 1000  # B 단독 글자는 그대로 B
    feats = {fr.FeatureTag for fr in font["GSUB"].table.FeatureList.FeatureRecord}
    assert "ss01" in feats  # B의 기존 기능은 남는다
