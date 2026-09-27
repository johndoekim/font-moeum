"""font-moeum 한글 서브셋 프리셋 — 병합 결과에서 한글 음절·한자만 덜어내는 "빼기" 서브셋.

라틴·기호·박스 문자·powerline 등 프리셋 대상이 아닌 코드포인트는 전부 남겨 코딩
폰트가 망가지지 않게 한다. fontTools.subset을 쓰되 레이아웃 기능·name·힌팅·글리프
이름을 모두 보존하는 옵션으로 돌린다(웹 최적화가 아니라 "글자 범위만 줄이기").

프리셋:
  none      그대로
  no_hanja  한자 제거 (CJK 통합 한자·확장 A·호환 한자)
  ksx1001   한자 제거 + 한글 음절을 KS X 1001 완성형 2,350자로 + 조합형 자모 제거

GSUB 클로저 함정: 서브셋은 남는 글리프에서 GSUB로 닿는 글리프를 되살린다. mono 결과는
조합형 자모를 호환 자모(ㄱ·ㅏ — 남겨야 함)와 같은 글리프로 매핑하고 ccmp 리가처
(ㄱ+ㅏ→가)를 가지므로, 그대로 두면 버린 음절 8,822자가 전부 되살아난다. 그래서
서브셋 전에 "출력이 제거 대상 글리프인 리가처"를 먼저 지운다(_prune_ligatures_to).

사용 예:
    uv run subset_presets.py merged.ttf --preset ksx1001 -o out.ttf
"""

import argparse
import shutil
import sys
from functools import lru_cache
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables import otTables

PRESETS = ("none", "no_hanja", "ksx1001")

HANJA_RANGES = [(0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0xF900, 0xFAFF)]
JAMO_RANGES = [(0x1100, 0x11FF), (0xA960, 0xA97F), (0xD7B0, 0xD7FF)]  # 조합형 자모


@lru_cache(maxsize=1)
def ksx1001_syllables() -> frozenset[int]:
    """KS X 1001 완성형 한글 2,350자 = EUC-KR에서 2바이트로 인코딩되는 음절.

    인코딩 "성공" 여부로 고르면 안 된다 — CPython euc_kr은 나머지 8,822자도
    KS X 1001:1998 부속서 3의 8바이트 조합 시퀀스로 인코딩해 준다.
    """
    return frozenset(cp for cp in range(0xAC00, 0xD7A4)
                     if len(chr(cp).encode("euc_kr")) == 2)


def _dropped(cp: int, preset: str) -> bool:
    if any(lo <= cp <= hi for lo, hi in HANJA_RANGES):
        return True
    if preset == "ksx1001":
        if any(lo <= cp <= hi for lo, hi in JAMO_RANGES):
            return True
        if 0xAC00 <= cp <= 0xD7A3:
            return cp not in ksx1001_syllables()
    return False


def _prune_ligatures_to(font: TTFont, targets: set[str]) -> int:
    """GSUB 리가처 중 출력이 targets인 규칙을 지우고 지운 개수를 돌려준다."""
    if "GSUB" not in font or not targets:
        return 0
    removed = 0
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for subtable in lookup.SubTable:
            if isinstance(subtable, otTables.ExtensionSubst):
                subtable = subtable.ExtSubTable
            if not isinstance(subtable, otTables.LigatureSubst):
                continue
            for first, ligatures in list(subtable.ligatures.items()):
                kept = [lig for lig in ligatures if lig.LigGlyph not in targets]
                removed += len(ligatures) - len(kept)
                if kept:
                    subtable.ligatures[first] = kept
                else:
                    del subtable.ligatures[first]
    return removed


def _options() -> Options:
    opts = Options()
    opts.layout_features = ["*"]  # calt/liga 등 A의 기능과 mono ccmp를 그대로
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.name_legacy = True
    opts.notdef_outline = True
    opts.glyph_names = True
    opts.hinting = True
    opts.legacy_kern = True
    opts.symbol_cmap = True
    return opts


def subset_file(path, preset: str) -> dict | None:
    """path를 제자리에서 서브셋하고 통계를 돌려준다. preset이 none이면 손대지 않고 None."""
    if preset not in PRESETS:
        raise ValueError(f"알 수 없는 서브셋 프리셋: {preset}")
    if preset == "none":
        return None
    path = Path(path)
    bytes_before = path.stat().st_size
    font = TTFont(str(path))
    glyphs_before = len(font.getGlyphOrder())
    cmap = font.getBestCmap() or {}
    keep = [cp for cp in cmap if not _dropped(cp, preset)]
    # 남는 코드포인트가 하나라도 쓰는 글리프는 대상에서 뺀다(공유 글리프 보호)
    dropped_glyphs = {cmap[cp] for cp in cmap} - {cmap[cp] for cp in keep}
    _prune_ligatures_to(font, dropped_glyphs)

    subsetter = Subsetter(options=_options())
    subsetter.populate(unicodes=keep)
    subsetter.subset(font)
    font.save(str(path))
    return {
        "preset": preset,
        "codepoints_removed": len(cmap) - len(keep),
        "glyphs_before": glyphs_before,
        "glyphs_after": len(font.getGlyphOrder()),
        "bytes_before": bytes_before,
        "bytes_after": path.stat().st_size,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="subset_presets.py",
        description="병합 결과 폰트에서 한글 음절·한자만 줄인다 (라틴·기호 등은 전부 유지).",
    )
    parser.add_argument("font", type=Path, help="입력 폰트 (TTF)")
    parser.add_argument("--preset", choices=PRESETS[1:], required=True,
                        help="no_hanja: 한자 제거 · ksx1001: 한자 제거 + 한글 2,350자")
    parser.add_argument("-o", "--output", type=Path, required=True, help="출력 경로")
    args = parser.parse_args(argv)

    shutil.copyfile(args.font, args.output)
    stats = subset_file(args.output, args.preset)
    print(f"서브셋 완료: {args.output} — 코드포인트 {stats['codepoints_removed']}개 제거, "
          f"글리프 {stats['glyphs_before']} → {stats['glyphs_after']}, "
          f"{stats['bytes_before']:,} → {stats['bytes_after']:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
