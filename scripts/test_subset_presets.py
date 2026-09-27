"""한글 서브셋 프리셋 검증 — sample 두 폰트의 mono 병합 결과를 실제로 줄여 본다.

핵심 회귀 두 가지:
- CPython euc_kr은 2,350자 밖 음절도 8바이트 조합 시퀀스로 "인코딩에 성공"한다 —
  인코딩 성공 여부로 고르면 11,172자가 전부 남는다.
- mono 결과의 자모 ccmp(L+V+T → 음절)가 GSUB 클로저로 버린 음절 글리프를 되살리지 않는지.

실행: uv run --directory scripts pytest -q
"""

import shutil
from pathlib import Path

import pytest
from fontTools.ttLib import TTFont

from fitmerge import fit_merge_to_file
from subset_presets import HANJA_RANGES, JAMO_RANGES, ksx1001_syllables, subset_file

SAMPLE = Path(__file__).resolve().parent.parent / "sample"
FONT_A = SAMPLE / "JetBrainsMono-Regular.ttf"
FONT_B = SAMPLE / "D2Coding-Ver1.3.2-20180524.ttf"


def _in(cp, ranges):
    return any(lo <= cp <= hi for lo, hi in ranges)


def _is_syllable(cp):
    return 0xAC00 <= cp <= 0xD7A3


@pytest.fixture(scope="module")
def mono_merged(tmp_path_factory):
    out = tmp_path_factory.mktemp("subset") / "mono.ttf"
    fit_merge_to_file(FONT_A, FONT_B, out, name="SubsetTest", jamo_ccmp=True)
    return out


@pytest.fixture
def work_copy(mono_merged, tmp_path):
    dst = tmp_path / "work.ttf"
    shutil.copy(mono_merged, dst)
    return dst


def test_ksx1001_is_exactly_2350_syllables():
    ksx = ksx1001_syllables()
    assert len(ksx) == 2350
    assert ord("가") in ksx and ord("힝") in ksx
    assert ord("똠") not in ksx  # KS X 1001 완성형에 없는 것으로 유명한 글자


def test_none_leaves_file_untouched(work_copy):
    before = work_copy.read_bytes()
    assert subset_file(work_copy, "none") is None
    assert work_copy.read_bytes() == before


def test_unknown_preset_is_rejected(work_copy):
    with pytest.raises(ValueError):
        subset_file(work_copy, "gb2312")


def test_ksx1001_trims_hangul_and_keeps_everything_else(work_copy):
    before_cmap = TTFont(str(work_copy)).getBestCmap()
    stats = subset_file(work_copy, "ksx1001")

    font = TTFont(str(work_copy), lazy=False)
    font.ensureDecompiled(recurse=True)
    cmap = font.getBestCmap()
    syllables = {cp for cp in cmap if _is_syllable(cp)}
    assert syllables == ksx1001_syllables() & set(before_cmap)
    assert not any(_in(cp, HANJA_RANGES) or _in(cp, JAMO_RANGES) for cp in cmap)
    # 라틴·기호·박스 문자 등 프리셋 대상이 아닌 코드포인트는 하나도 잃지 않는다
    kept = {cp for cp in before_cmap
            if not (_is_syllable(cp) or _in(cp, HANJA_RANGES) or _in(cp, JAMO_RANGES))}
    assert kept <= set(cmap)
    # ccmp 클로저가 버린 음절 글리프를 되살리면 글리프 수가 거의 줄지 않는다
    assert stats["glyphs_before"] - stats["glyphs_after"] > 8000
    assert stats["bytes_after"] < stats["bytes_before"] / 2
    assert stats["glyphs_after"] == len(font.getGlyphOrder())


def test_no_hanja_keeps_all_hangul(work_copy):
    before_cmap = TTFont(str(work_copy)).getBestCmap()
    subset_file(work_copy, "no_hanja")
    cmap = TTFont(str(work_copy)).getBestCmap()
    assert not any(_in(cp, HANJA_RANGES) for cp in cmap)
    assert {cp for cp in cmap if _is_syllable(cp)} == {cp for cp in before_cmap if _is_syllable(cp)}
