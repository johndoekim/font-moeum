"""font-moeum 병합 엔진.

영문 TTF(A) + 한글 TTF(B)를 하나의 TTF로 병합한다.
CLI로도 쓰고(merge.py 직접 실행), 사이드카(sidecar.py)가 라이브러리로도 쓴다.

- TrueType(glyf)만 지원 — fontTools Merger는 CFF(OTF) 병합 불가
- 병합 전 unitsPerEm 통일(scale_upem) — 안 맞추면 A글자·B글자 크기가 따로 놈
- merge 리스트 첫 번째 폰트가 겹치는 코드포인트(라틴/숫자/문장부호)의 cmap을 가짐
- name 테이블 재작성으로 새 패밀리 이름 부여 — 원본 이름 충돌 방지 + OFL의
  "원래 폰트 이름 재사용 금지" 준수

사용 예:
    uv run merge.py a.ttf b.ttf --name "MyMerge" --base A -o out.ttf
"""

import argparse
import sys
import tempfile
import time
from pathlib import Path

from fontTools.merge import Merger
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem

# 사이드카 I/O는 콘솔 코드페이지(Windows cp949 등)와 무관하게 UTF-8 고정.
# stdout은 사이드카 프로토콜 전용이므로 라이브러리 함수는 stderr에만 쓴다.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

WIN = (3, 1, 0x409)  # platformID, platEncID, langID
MAC = (1, 0, 0)

# CJK 코드포인트 범위 — 두 엔진 공용. category 태그(hangul/jamo/hanja/fullwidth)는
# fitmerge의 복사 로직이 소비하고, basic 모드(cjk_source)는 전 범위를 하나로 취급한다.
CJK_RANGES = [
    (0xAC00, 0xD7A3, "hangul"),     # 한글 음절
    (0x1100, 0x11FF, "jamo"),       # 조합형 자모
    (0x3130, 0x318F, "hangul"),     # 호환 자모
    (0xA960, 0xA97F, "hangul"),     # 자모 확장-A
    (0xD7B0, 0xD7FF, "hangul"),     # 자모 확장-B
    (0x4E00, 0x9FFF, "hanja"),      # CJK 통합 한자
    (0x3000, 0x303F, "fullwidth"),  # CJK 기호·구두점
    (0xFF00, 0xFFEF, "fullwidth"),  # 전각/반각 형태
]


class MergeError(Exception):
    """입력 검증/병합 단계에서 사용자에게 보여줄 오류."""

    def __init__(self, msg: str, code: int = 1):
        super().__init__(msg)
        self.code = code


def load_ttf(path: Path) -> TTFont:
    """TTF를 로드하고 TrueType(glyf) 아웃라인인지 검증한다."""
    if not path.is_file():
        raise MergeError(f"파일이 없습니다: {path}")
    try:
        font = TTFont(str(path))
    except Exception as e:
        raise MergeError(f"폰트를 열 수 없습니다 ({path.name}): {e}")
    if "glyf" not in font:
        kind = "CFF(OTF)" if ("CFF " in font or "CFF2" in font) else "알 수 없는 형식"
        raise MergeError(f"{path.name}: TrueType(glyf) 폰트가 아닙니다 — {kind}. TTF만 지원합니다.")
    return font


def rewrite_names(font: TTFont, family: str, style: str = "Regular") -> None:
    """출력 폰트의 name 테이블을 새 패밀리 이름으로 재작성한다."""
    name = font["name"]
    ps_family = "".join(family.split())  # PostScript 이름은 공백 불가
    ps_style = "".join(style.split())    # PostScript 이름은 공백 불가 ("Bold Italic" → "BoldItalic")
    entries = {
        1: family,                          # Family
        2: style,                           # Subfamily
        3: f"{family} {style}; font-moeum", # Unique ID
        4: f"{family} {style}",             # Full name
        6: f"{ps_family}-{ps_style}",       # PostScript name
        16: family,                         # Typographic family
        17: style,                          # Typographic subfamily
    }
    for nid, value in entries.items():
        name.removeNames(nameID=nid)
        name.setName(value, nid, *WIN)
        name.setName(value, nid, *MAC)


def apply_style_bits(font: TTFont, style: str) -> None:
    """style에 따라 OS/2.fsSelection · head.macStyle · OS/2.usWeightClass를 설정한다.

    허용 style: "Regular" | "Bold" | "Italic" | "Bold Italic"
    각 비트 플래그는 관련 비트만 클리어한 뒤 다시 설정한다 — USE_TYPO_METRICS 등
    다른 비트는 건드리지 않는다. usWeightClass는 bold일 때만 700으로 올리고,
    bold가 아니면 원본 값(A 폰트가 Light 등이어도)을 그대로 둔다.
    """
    bold = "Bold" in style
    italic = "Italic" in style

    if "OS/2" in font:
        os2 = font["OS/2"]
        fs = os2.fsSelection
        fs &= ~((1 << 0) | (1 << 5) | (1 << 6))  # ITALIC, BOLD, REGULAR 클리어
        if italic:
            fs |= 1 << 0
        if bold:
            fs |= 1 << 5
        if not bold and not italic:
            fs |= 1 << 6
        os2.fsSelection = fs
        if bold:
            os2.usWeightClass = 700

    if "head" in font:
        head = font["head"]
        ms = head.macStyle
        ms &= ~((1 << 0) | (1 << 1))  # Bold, Italic 클리어
        if bold:
            ms |= 1 << 0
        if italic:
            ms |= 1 << 1
        head.macStyle = ms


def _strip_overlapping_cjk(loser: TTFont, winner: TTFont) -> int:
    """양쪽이 모두 커버하는 CJK 코드포인트를 loser의 유니코드 cmap에서 삭제한다.

    Merger는 폰트별로 format 12(있으면) 아니면 format 4만 소비하므로 두 포맷
    모두에서 지운다. format 14(UVS)는 불변 — default 엔트리는 병합 후 메가
    cmap 기준으로 해석돼 자동으로 이긴 쪽을 따라간다. loser 단독 코드포인트는
    유지(커버리지 손실 방지). 글리프 자체는 남는다(v1 트레이드오프).
    """
    loser_cmap = loser.getBestCmap() or {}
    winner_cmap = winner.getBestCmap() or {}
    targets = {cp for cp in loser_cmap if cp in winner_cmap
               and any(lo <= cp <= hi for lo, hi, _cat in CJK_RANGES)}
    for subtable in loser["cmap"].tables:  # fitmerge의 서브테이블 순회 관례와 동일
        if subtable.format == 14:
            continue
        if not (subtable.platformID == 0
                or (subtable.platformID == 3 and subtable.platEncID in (1, 10))):
            continue
        for cp in targets:
            subtable.cmap.pop(cp, None)
    return len(targets)


def merge_to_file(font_a, font_b, output, *, name: str = "MoeumMerged",
                  base: str = "A", upem: int | None = None, style: str = "Regular",
                  cjk_source: str | None = None) -> Path:
    """두 TTF를 병합해 output에 저장하고 경로를 돌려준다. 실패 시 MergeError.

    cjk_source가 base와 다르면 겹치는 CJK(CJK_RANGES)만 그 폰트가 가진다 —
    None(기본)이면 base를 따르는 기존 동작.
    """
    paths = {"A": Path(font_a), "B": Path(font_b)}
    fonts = {key: load_ttf(path) for key, path in paths.items()}

    # 세로 조판 테이블(vhea/vmtx)이 한쪽에만 있으면 Merger가 속성 병합에서
    # NotImplemented와 int를 비교하다 죽는다(업스트림 제약 — 맑은 고딕 등 세로
    # 메트릭을 가진 한글 폰트가 걸림). 가진 쪽에서 제거하고 경고만 남긴다 —
    # 이 툴의 산출물은 가로쓰기 용도라 세로 메트릭 소실은 실사용 영향이 없다.
    for tag in ("vhea", "vmtx"):
        has = {key: tag in font for key, font in fonts.items()}
        if has["A"] != has["B"]:
            owner = "A" if has["A"] else "B"
            del fonts[owner][tag]
            print(f"{owner}({paths[owner].name}): 한쪽에만 있는 세로 메트릭 '{tag}' 제거 "
                  f"— Merger가 단측 세로 테이블을 병합하지 못함", file=sys.stderr)

    # JSTF(양쪽 정렬 데이터)는 Merger의 범용 병합이 내부 리스트 속성에서 죽는다
    # (Arial·Times 등 MS 폰트가 보유). 현대 셰이퍼는 소비하지 않는 테이블이라
    # 항상 제거 — 양쪽에 있어도 병합 불가능한 것은 마찬가지다.
    for key, font in fonts.items():
        if "JSTF" in font:
            del font["JSTF"]
            print(f"{key}({paths[key].name}): 'JSTF' 제거 — Merger가 병합하지 못하는 "
                  f"테이블 (렌더링 영향 없음)", file=sys.stderr)

    # unitsPerEm 통일 — 기본은 큰 쪽에 맞춰 확대(정밀도 손실 최소화)
    upems = {key: font["head"].unitsPerEm for key, font in fonts.items()}
    target_upem = upem or max(upems.values())

    # base 폰트를 리스트 첫 번째로 — 겹치는 cmap에서 첫 번째가 이긴다
    order = ["A", "B"] if base == "A" else ["B", "A"]

    # 겹치는 CJK만 cjk_source가 이기게: 지는 쪽(= base, 모든 걸 이기는 쪽)의 cmap에서
    # 교집합 CJK를 미리 삭제해 Merger의 first-wins를 우회한다.
    if cjk_source and cjk_source != base:
        if cjk_source not in ("A", "B"):
            raise MergeError(f"cjk_source는 A 또는 B여야 합니다: {cjk_source}")
        removed = _strip_overlapping_cjk(loser=fonts[base], winner=fonts[cjk_source])
        print(f"CJK 담당({cjk_source}): 겹치는 CJK {removed}자 — {base} cmap에서 제거",
              file=sys.stderr)

    with tempfile.TemporaryDirectory() as tmp:
        merge_files = []
        for key in order:
            font = fonts[key]
            if upems[key] != target_upem:
                print(f"{key}({paths[key].name}): unitsPerEm {upems[key]} → {target_upem}",
                      file=sys.stderr)
                scale_upem(font, target_upem)
            tmp_path = Path(tmp) / f"{key}.ttf"
            font.save(str(tmp_path))
            merge_files.append(str(tmp_path))

        try:
            merged = Merger().merge(merge_files)
        except Exception as e:
            raise MergeError(f"병합 실패: {e}", code=2)

        # name 재작성 후 저장 (임시 파일이 살아있는 동안 완료해야 함)
        rewrite_names(merged, name, style)
        apply_style_bits(merged, style)
        out_path = Path(output)
        merged.save(str(out_path))

    return out_path


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="merge.py",
        description="영문 TTF(A) + 한글 TTF(B)를 하나의 TTF로 병합한다.",
    )
    parser.add_argument("font_a", type=Path, help="폰트 A — 우선. 겹치는 글리프를 가짐 (보통 영문)")
    parser.add_argument("font_b", type=Path, help="폰트 B — 보충. A에 없는 글리프 담당 (보통 한글)")
    parser.add_argument("--name", default="MoeumMerged",
                        help="출력 폰트 패밀리 이름 (기본: %(default)s)")
    parser.add_argument("--base", choices=["A", "B"], default="A",
                        help="겹치는 라틴/숫자/문장부호를 가질 폰트 (기본: %(default)s)")
    parser.add_argument("--cjk", choices=["A", "B"], default=None,
                        help="겹치는 한글·한자·전각(CJK)을 가질 폰트 (기본: --base를 따름)")
    parser.add_argument("-o", "--output", type=Path, default=None,
                        help="출력 경로 (기본: <name>.ttf)")
    parser.add_argument("--upem", type=int, default=None,
                        help="통일할 unitsPerEm (기본: 두 폰트 중 큰 값)")
    parser.add_argument("--style", choices=["Regular", "Bold", "Italic", "Bold Italic"], default="Regular",
                        help="출력 폰트 스타일 (기본: %(default)s)")
    args = parser.parse_args(argv)

    t0 = time.perf_counter()
    out_path = args.output or Path(f"{args.name}.ttf")
    try:
        merge_to_file(args.font_a, args.font_b, out_path,
                      name=args.name, base=args.base, upem=args.upem, style=args.style,
                      cjk_source=args.cjk)
    except MergeError as e:
        print(f"오류: {e}", file=sys.stderr)
        return e.code

    elapsed = time.perf_counter() - t0
    first, second = ("A", "B") if args.base == "A" else ("B", "A")
    names = {"A": args.font_a.name, "B": args.font_b.name}
    print(f"병합 완료: {out_path} — 패밀리 '{args.name}', {elapsed:.1f}초")
    print(f"  우선({first}): {names[first]} · 보조: {names[second]}")
    if args.cjk and args.cjk != args.base:
        print(f"  CJK 담당({args.cjk}): {names[args.cjk]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
