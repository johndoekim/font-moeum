"""font-moa 병합 엔진.

영문 TTF(A) + 한글 TTF(B)를 하나의 TTF로 병합한다.

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
# Phase 3의 stdin/stdout 프로토콜도 이 전제를 따른다.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

WIN = (3, 1, 0x409)  # platformID, platEncID, langID
MAC = (1, 0, 0)


def fail(msg: str, code: int = 1) -> None:
    print(f"오류: {msg}", file=sys.stderr)
    sys.exit(code)


def load_ttf(path: Path) -> TTFont:
    """TTF를 로드하고 TrueType(glyf) 아웃라인인지 검증한다."""
    if not path.is_file():
        fail(f"파일이 없습니다: {path}")
    try:
        font = TTFont(str(path))
    except Exception as e:
        fail(f"폰트를 열 수 없습니다 ({path.name}): {e}")
    if "glyf" not in font:
        kind = "CFF(OTF)" if ("CFF " in font or "CFF2" in font) else "알 수 없는 형식"
        fail(f"{path.name}: TrueType(glyf) 폰트가 아닙니다 — {kind}. TTF만 지원합니다.")
    return font


def rewrite_names(font: TTFont, family: str, style: str = "Regular") -> None:
    """출력 폰트의 name 테이블을 새 패밀리 이름으로 재작성한다."""
    name = font["name"]
    ps_family = "".join(family.split())  # PostScript 이름은 공백 불가
    entries = {
        1: family,                          # Family
        2: style,                           # Subfamily
        3: f"{family} {style}; font-moa",   # Unique ID
        4: f"{family} {style}",             # Full name
        6: f"{ps_family}-{style}",          # PostScript name
        16: family,                         # Typographic family
        17: style,                          # Typographic subfamily
    }
    for nid, value in entries.items():
        name.removeNames(nameID=nid)
        name.setName(value, nid, *WIN)
        name.setName(value, nid, *MAC)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="merge.py",
        description="영문 TTF(A) + 한글 TTF(B)를 하나의 TTF로 병합한다.",
    )
    parser.add_argument("font_a", type=Path, help="폰트 A (영문)")
    parser.add_argument("font_b", type=Path, help="폰트 B (한글)")
    parser.add_argument("--name", default="MoaMerged",
                        help="출력 폰트 패밀리 이름 (기본: %(default)s)")
    parser.add_argument("--base", choices=["A", "B"], default="A",
                        help="겹치는 라틴/숫자/문장부호를 가질 폰트 (기본: %(default)s)")
    parser.add_argument("-o", "--output", type=Path, default=None,
                        help="출력 경로 (기본: <name>.ttf)")
    parser.add_argument("--upem", type=int, default=None,
                        help="통일할 unitsPerEm (기본: 두 폰트 중 큰 값)")
    args = parser.parse_args(argv)

    t0 = time.perf_counter()
    out_path = args.output or Path(f"{args.name}.ttf")

    paths = {"A": args.font_a, "B": args.font_b}
    fonts = {key: load_ttf(path) for key, path in paths.items()}

    # 2b. unitsPerEm 통일 — 기본은 큰 쪽에 맞춰 확대(정밀도 손실 최소화)
    upems = {key: font["head"].unitsPerEm for key, font in fonts.items()}
    target_upem = args.upem or max(upems.values())

    # 2c. base 폰트를 리스트 첫 번째로 — 겹치는 cmap에서 첫 번째가 이긴다
    order = ["A", "B"] if args.base == "A" else ["B", "A"]

    with tempfile.TemporaryDirectory() as tmp:
        merge_files = []
        for key in order:
            font = fonts[key]
            if upems[key] != target_upem:
                print(f"{key}({paths[key].name}): unitsPerEm {upems[key]} → {target_upem}")
                scale_upem(font, target_upem)
            tmp_path = Path(tmp) / f"{key}.ttf"
            font.save(str(tmp_path))
            merge_files.append(str(tmp_path))

        try:
            merged = Merger().merge(merge_files)
        except Exception as e:
            fail(f"병합 실패: {e}", code=2)

        # 2d. name 테이블 재작성 후 저장 (임시 파일이 살아있는 동안 완료해야 함)
        rewrite_names(merged, args.name)
        merged.save(str(out_path))

    elapsed = time.perf_counter() - t0
    print(f"병합 완료: {out_path} — 패밀리 '{args.name}', upem {target_upem}, {elapsed:.1f}초")
    print(f"  우선({args.base}): {paths[order[0]].name} · 보조: {paths[order[1]].name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
