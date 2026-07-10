"""정적 OTF(CFF) → TTF(glyf) 변환.

fontTools Snippets/otf2ttf.py 레시피(MIT) 기반. 3차 곡선을 cu2qu로 2차 근사하고
CFF 계열 테이블을 glyf/loca로 교체한다. CFF 힌팅은 소실되며, 곡선 오차는
1000 UPM당 최대 1.0유닛(em의 0.1%) — 시각적으로 구분 불가 수준.

CLI로 단독 검증 가능(엔진은 앱과 무관하게 단독 검증 원칙):
    uv run otf2ttf.py in.otf -o out.ttf [--max-err 1.0]
load_ttf(merge.py)가 라이브러리로도 쓴다 — CFF 존재 확인은 호출자 책임.
"""

import argparse
import sys
import time
from pathlib import Path

from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable

sys.stderr.reconfigure(encoding="utf-8")

# 1000 UPM당 허용 오차(폰트 유닛) — 업스트림 스니펫 관례. upem에 비례 스케일해
# 1000이 아닌 OTF(드묾)에서도 상대 오차가 일정하게 유지된다.
MAX_ERR_PER_1000_UPEM = 1.0

# maxp 0.5(CFF)에는 없는 v1.0 필드 — TT 인스트럭션이 없으므로 전부 0이 정답.
# (maxPoints 등 recalc가 채우는 필드는 저장 시 재계산되지만, recalcBBoxes=False
#  저장 경로에서도 컴파일이 죽지 않도록 방어적으로 0을 깔아둔다)
_MAXP_V1_FIELDS = (
    "maxPoints", "maxContours", "maxCompositePoints", "maxCompositeContours",
    "maxZones", "maxTwilightPoints", "maxStorage", "maxFunctionDefs",
    "maxInstructionDefs", "maxStackElements", "maxSizeOfInstructions",
    "maxComponentElements", "maxComponentDepth",
)


def otf_to_ttf(font: TTFont, *, max_err: float | None = None,
               reverse_direction: bool = True) -> None:
    """CFF OTF를 in-place로 TTF(glyf)로 변환한다.

    reverse_direction=True: PostScript(반시계) → TrueType(시계) 윤곽 방향 반전.
    T2 seac 합성 글리프는 draw 중 평탄화되어 결과는 전부 단순 글리프다.
    """
    if max_err is None:
        max_err = MAX_ERR_PER_1000_UPEM * font["head"].unitsPerEm / 1000

    glyph_order = font.getGlyphOrder()
    glyph_set = font.getGlyphSet()
    quad_glyphs = {}
    for name in glyph_order:
        tt_pen = TTGlyphPen(glyph_set)
        glyph_set[name].draw(Cu2QuPen(tt_pen, max_err, reverse_direction=reverse_direction))
        quad_glyphs[name] = tt_pen.glyph()

    font["loca"] = newTable("loca")
    glyf = font["glyf"] = newTable("glyf")
    glyf.glyphOrder = glyph_order
    glyf.glyphs = quad_glyphs
    for tag in ("CFF ", "VORG", "DSIG"):  # DSIG: 수정된 폰트의 서명은 무효
        if tag in font:
            del font[tag]
    glyf.compile(font)  # 글리프별 바운딩 박스(xMin 등) 산출 — lsb 보정에 필요

    hmtx = font["hmtx"]
    for name, glyph in glyf.glyphs.items():
        if hasattr(glyph, "xMin"):
            hmtx[name] = (hmtx[name][0], glyph.xMin)

    maxp = font["maxp"]
    maxp.tableVersion = 0x00010000
    for attr in _MAXP_V1_FIELDS:
        if not hasattr(maxp, attr):
            setattr(maxp, attr, 0)

    # post 2.0으로 글리프 이름 보존 — 변환 캐시 파일을 ttx로 디버깅할 수 있게.
    # (basic 엔진 산출물은 Merger가 어차피 3.0으로 만든다)
    post = font["post"]
    post.formatType = 2.0
    post.extraNames = []
    post.mapping = {}
    post.glyphOrder = glyph_order

    font.sfntVersion = "\x00\x01\x00\x00"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="정적 OTF(CFF)를 TTF로 변환")
    parser.add_argument("input", type=Path, help="입력 .otf")
    parser.add_argument("-o", "--output", type=Path, required=True, help="출력 .ttf")
    parser.add_argument("--max-err", type=float, default=None,
                        help=f"곡선 근사 허용 오차(폰트 유닛) — 기본 {MAX_ERR_PER_1000_UPEM}/1000upem")
    args = parser.parse_args(argv)

    font = TTFont(str(args.input))
    if "CFF " not in font:
        print(f"{args.input.name}: CFF 테이블이 없습니다 — 정적 OTF가 아닙니다", file=sys.stderr)
        return 1
    t0 = time.perf_counter()
    otf_to_ttf(font, max_err=args.max_err)
    font.save(str(args.output))
    print(f"{args.input.name}: OTF(CFF) → TTF 변환 {time.perf_counter() - t0:.1f}초 "
          f"→ {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
