"""font-moeum 코딩 폰트 병합 엔진 (fitmerge).

고정폭 영문 TTF(A)를 베이스로 열고, 한글 TTF(B)의 CJK 글리프를 펜 파이프라인으로
스케일·중앙정렬해 A에 복사한다 (kuskhan/jetendard 방식). fontTools Merger를 쓰는
merge.py와 달리 A의 테이블(GSUB 리가처·힌팅·세로 메트릭)을 그대로 보존하고,
한글은 라틴 폭의 정수배 셀에 맞춰 들어간다 — 터미널/에디터용 코딩 폰트 특화.

- A는 고정폭(모노스페이스) 필수 — check_monospace()로 검증
- 한글 폭 = 라틴 폭 × width_mult (기본 2배), 셀 밖으로 나가면 자동 축소(capped)
- unitsPerEm은 A 기준 — scale_upem 대신 좌표 변환(펜)에 UPM 비율을 흡수
- 조합형 자모(U+1100–)는 B에 글리프가 없어도 호환 자모(U+3130–) 글리프로 폴백
- name 재작성·스타일 비트는 merge.py의 rewrite_names/apply_style_bits 재사용

사용 예:
    uv run fitmerge.py a.ttf b.ttf --name "MyMono" --korean-scale 1.15 -o out.ttf
"""

import argparse
import sys
import time
import unicodedata
from pathlib import Path

from fontTools.misc.roundTools import otRound
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

from merge import MergeError, apply_style_bits, load_ttf, rewrite_names

# 사이드카 I/O는 콘솔 코드페이지(Windows cp949 등)와 무관하게 UTF-8 고정.
# stdout은 사이드카 프로토콜 전용이므로 라이브러리 함수는 stderr에만 쓴다.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

# 고정폭 검증용 프로브 문자 — 폭이 다르기 쉬운 좁은/넓은 글자를 섞음
MONO_PROBE = " A0Hinmw"

# 복사 대상 코드포인트 범위. category:
#   hangul    — 항상 복사·cmap 덮어쓰기 (B 승리)
#   jamo      — 항상 복사, 호환 자모 소스 매핑 적용 (아래 _jamo_source)
#   hanja     — include_hanja일 때만 (hanja_copied 별도 집계)
#   fullwidth — fullwidth_source에 따라 덮어쓰기(B) 또는 A에 없는 것만 보충(A)
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


def check_monospace(font) -> int:
    """A 폰트가 고정폭인지 검증하고 그 폭(hmtx advance)을 반환한다.

    프로브 8글자(" A0Hinmw")의 advance가 전부 동일해야 한다. cmap에 없는
    글자가 있거나 폭이 서로 다르면 MergeError.
    """
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    widths = set()
    for ch in MONO_PROBE:
        glyph_name = cmap.get(ord(ch))
        if glyph_name is None:
            raise MergeError(
                "A 폰트가 고정폭(모노스페이스)이 아닙니다 — 코딩 폰트 모드는 "
                "고정폭 영문 폰트가 필요합니다.")
        widths.add(hmtx[glyph_name][0])
    if len(widths) != 1:
        raise MergeError(
            "A 폰트가 고정폭(모노스페이스)이 아닙니다 — 코딩 폰트 모드는 "
            "고정폭 영문 폰트가 필요합니다.")
    return widths.pop()


def _jamo_source(cp: int, cmap_b: dict) -> str | None:
    """조합형 자모 cp의 소스 글리프 이름을 B cmap에서 찾는다.

    초성/중성/종성은 이름의 마지막 토큰으로 대응 호환 자모(HANGUL LETTER ...)를
    찾아 그 글리프를 우선 사용한다 — 조합용 자모는 위치가 치우쳐 있어 단독 표시에
    부적합하고, B(D2Coding 등)에 아예 없는 경우도 많기 때문. lookup 실패나
    호환 자모 부재 시 B의 원래 글리프로 폴백, 그것도 없으면 None(건너뜀).
    """
    try:
        uname = unicodedata.name(chr(cp))
    except ValueError:
        uname = ""
    if any(kind in uname for kind in ("CHOSEONG", "JUNGSEONG", "JONGSEONG")):
        letter = uname.split()[-1]  # 예: "HANGUL CHOSEONG KIYEOK" → "KIYEOK"
        try:
            compat_cp = ord(unicodedata.lookup(f"HANGUL LETTER {letter}"))
        except KeyError:
            compat_cp = None
        if compat_cp is not None and compat_cp in cmap_b:
            return cmap_b[compat_cp]
    return cmap_b.get(cp)


def _unique_name(cp: int, existing: set) -> str:
    """새 글리프 이름 mo_uni{cp:04X}. A에 이미 있으면(비정상 폰트) 접미사로 유니크화."""
    base = f"mo_uni{cp:04X}"
    name = base
    suffix = 1
    while name in existing:
        suffix += 1
        name = f"{base}.{suffix}"
    return name


def fit_merge_to_file(font_a, font_b, output, *, name="MoeumMono", style="Regular",
                      korean_scale=1.15, width_mult=2.0, ty=0.0,
                      include_hanja=True, fullwidth_source="B") -> dict:
    """A(고정폭 라틴)에 B의 CJK 글리프를 셀에 맞춰 복사해 output에 저장한다.

    반환: {"path", "copied", "capped", "glyphs_added", "latin_advance",
           "korean_advance", "upem", "hanja_copied", "warnings"}
    실패 시 MergeError.
    """
    font_a = load_ttf(Path(font_a))
    font_b_path = Path(font_b)
    font_b = load_ttf(font_b_path)
    warnings: list[str] = []

    # --- 1. 검증·파라미터 계산 (전부 A의 좌표계 기준) ---
    latin_advance = check_monospace(font_a)
    korean_advance = round(latin_advance * width_mult)
    upem_a = font_a["head"].unitsPerEm
    upem_b = font_b["head"].unitsPerEm
    upm_scale = upem_a / upem_b          # B 좌표 → A 좌표 (scale_upem 대신 펜에 흡수)
    requested_scale = upm_scale * korean_scale
    side_guard = max(8, round(latin_advance * 0.02))  # 셀 좌우 여백 (이웃 글자 충돌 방지)
    ty_units = round(ty * upem_a)        # ty는 em 비율, 양수 = 위로

    # 세로 안전 범위 — 이 밖으로 나가면 에디터에서 줄 겹침/잘림
    hhea = font_a["hhea"]
    if "OS/2" in font_a:
        os2_a = font_a["OS/2"]
        safe_ymax = min(hhea.ascent, os2_a.sTypoAscender)
        safe_ymin = max(hhea.descent, os2_a.sTypoDescender)
    else:
        safe_ymax, safe_ymin = hhea.ascent, hhea.descent
    if safe_ymax <= 0 or safe_ymin >= 0:
        warnings.append(
            f"A 폰트의 세로 메트릭이 비정상입니다 (safe [{safe_ymin}, {safe_ymax}]) "
            f"— hhea 값으로 폴백합니다.")
        safe_ymax, safe_ymin = hhea.ascent, hhea.descent

    # --- 2. 복사 대상 코드포인트 수집 (B의 best cmap 기준) ---
    cmap_b = font_b.getBestCmap()
    if not cmap_b:
        raise MergeError(
            f"{font_b_path.name}: 유니코드 cmap이 없습니다 — 복사할 한글/CJK 글리프를 "
            f"찾을 수 없습니다.")
    cmap_a = font_a.getBestCmap()
    plan: list[tuple[int, str, str]] = []  # (코드포인트, B 소스 글리프 이름, category)
    for lo, hi, category in CJK_RANGES:
        if category == "hanja" and not include_hanja:
            continue
        for cp in range(lo, hi + 1):
            if category == "jamo":
                src = _jamo_source(cp, cmap_b)
            else:
                src = cmap_b.get(cp)
            if src is None:
                continue
            if category == "fullwidth" and fullwidth_source == "A" and cp in cmap_a:
                continue  # A 유지 — A에 없는 것만 보충
            plan.append((cp, src, category))

    # --- 3. 글리프별 변환·복사 (소스 글리프당 기록 1회, 이름 캐시로 공유) ---
    glyphset_b = font_b.getGlyphSet()
    glyf = font_a["glyf"]
    hmtx = font_a["hmtx"]
    new_order = list(font_a.getGlyphOrder())
    existing = set(new_order)

    source_cache: dict[str, str] = {}  # B 소스 글리프 이름 → 새 글리프 이름
    cmap_updates: dict[int, str] = {}
    copied = capped = glyphs_added = hanja_copied = 0

    for cp, src, category in plan:
        new_name = source_cache.get(src)
        if new_name is None:
            new_name = _unique_name(cp, existing)

            # 1회 기록 (컴포지트 평탄화) 후 바운즈·변환에 재생
            recording = DecomposingRecordingPen(glyphset_b, skipMissingComponents=True)
            glyphset_b[src].draw(recording)
            bounds_pen = BoundsPen(None)
            recording.replay(bounds_pen)

            tt_pen = TTGlyphPen(None)
            if bounds_pen.bounds is None:
                # 빈 글리프 (예: U+3000 전각 공백) — 윤곽 없이 폭만 등록
                glyph = tt_pen.glyph()
                lsb = 0
            else:
                xmin, ymin, xmax, ymax = bounds_pen.bounds
                # 스케일 캡 — 셀 폭·세로 안전 범위를 넘으면 축소
                scale = requested_scale
                width = xmax - xmin
                if width > 0:
                    scale = min(scale, (korean_advance - 2 * side_guard) / width)
                if ymax > 0:
                    scale = min(scale, safe_ymax / ymax)
                if ymin < 0:
                    scale = min(scale, safe_ymin / ymin)
                if scale < requested_scale - 1e-6:
                    capped += 1
                # 셀 중앙 정렬 (좌표 반올림은 otRound로 통일 — TTGlyphPen.glyph 내부와 동일)
                shift_x = korean_advance / 2 - scale * (xmin + xmax) / 2
                recording.replay(
                    TransformPen(tt_pen, (scale, 0, 0, scale, shift_x, ty_units)))
                glyph = tt_pen.glyph()
                lsb = otRound(xmin * scale + shift_x)

            glyf.glyphs[new_name] = glyph  # glyphOrder는 마지막에 일괄 동기화
            hmtx[new_name] = (korean_advance, lsb)
            new_order.append(new_name)
            existing.add(new_name)
            source_cache[src] = new_name
            glyphs_added += 1

        cmap_updates[cp] = new_name
        copied += 1
        if category == "hanja":
            hanja_copied += 1

    if copied == 0:
        raise MergeError("B 폰트에서 복사할 한글/CJK 글리프를 찾지 못했습니다.")

    # glyph order 갱신 — 폰트·glyf 테이블 양쪽 동기화 (maxp/hmtx는 저장 시 재계산)
    font_a.setGlyphOrder(new_order)
    glyf.glyphOrder = new_order

    # cmap 갱신 — 모든 유니코드 서브테이블 (UVS format 14 제외, format 4는 BMP만)
    for subtable in font_a["cmap"].tables:
        if subtable.format == 14:
            continue
        if not (subtable.platformID == 0
                or (subtable.platformID == 3 and subtable.platEncID in (1, 10))):
            continue
        for cp, glyph_name in cmap_updates.items():
            if subtable.format == 4 and cp > 0xFFFF:
                continue
            subtable.cmap[cp] = glyph_name

    # --- 4. 후처리 ---
    # 고정폭 선언 (터미널/에디터가 모노스페이스로 인식하도록)
    font_a["post"].isFixedPitch = 1
    if "OS/2" in font_a:
        os2_a = font_a["OS/2"]
        os2_a.panose.bProportion = 9  # Monospaced
        # 코드페이지는 B(한국어 등) 것과 합집합, 유니코드 범위는 cmap에서 재계산
        if "OS/2" in font_b:
            os2_b = font_b["OS/2"]
            for attr in ("ulCodePageRange1", "ulCodePageRange2"):
                if hasattr(os2_a, attr) and hasattr(os2_b, attr):
                    setattr(os2_a, attr, getattr(os2_a, attr) | getattr(os2_b, attr))
        os2_a.recalcUnicodeRanges(font_a)

    # 새 글리프에 대해 무효인 디바이스 메트릭 테이블 제거
    for tag in ("hdmx", "LTSH", "VDMX"):
        if tag in font_a:
            del font_a[tag]

    # 세로 메트릭(hhea/OS/2 ascent·descent 등)과 A의 GSUB/GPOS는 건드리지 않는다 —
    # A의 줄 간격·리가처를 그대로 보존하는 것이 이 모드의 설계.

    rewrite_names(font_a, name, style)
    apply_style_bits(font_a, style)
    out_path = Path(output)
    font_a.save(str(out_path))

    return {
        "path": str(out_path),
        "copied": copied,
        "capped": capped,
        "glyphs_added": glyphs_added,
        "latin_advance": latin_advance,
        "korean_advance": korean_advance,
        "upem": upem_a,
        "hanja_copied": hanja_copied,
        "warnings": warnings,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fitmerge.py",
        description="고정폭 영문 TTF(A)에 한글 TTF(B)의 CJK 글리프를 셀에 맞춰 복사한다 (코딩 폰트 모드).",
    )
    parser.add_argument("font_a", type=Path, help="폰트 A — 고정폭 영문 베이스. 라틴·기호·리가처 담당")
    parser.add_argument("font_b", type=Path, help="폰트 B — 한글/CJK 글리프 공급")
    parser.add_argument("--name", default="MoeumMono",
                        help="출력 폰트 패밀리 이름 (기본: %(default)s)")
    parser.add_argument("--style", choices=["Regular", "Bold", "Italic", "Bold Italic"], default="Regular",
                        help="출력 폰트 스타일 (기본: %(default)s)")
    parser.add_argument("-o", "--output", type=Path, default=None,
                        help="출력 경로 (기본: <name>.ttf)")
    parser.add_argument("--korean-scale", type=float, default=1.15,
                        help="한글 확대 배율 (기본: %(default)s)")
    parser.add_argument("--width-mult", type=float, default=2.0,
                        help="한글 폭 = 라틴 폭 × 이 배수 (기본: %(default)s)")
    parser.add_argument("--ty", type=float, default=0.0,
                        help="한글 세로 이동 — em 비율, 양수 = 위로 (기본: %(default)s)")
    parser.add_argument("--no-hanja", action="store_true",
                        help="한자(U+4E00–9FFF) 복사 생략")
    parser.add_argument("--fullwidth", choices=["A", "B"], default="B",
                        help="전각 구두점(U+3000–303F·FF00–FFEF)을 가질 폰트 (기본: %(default)s)")
    args = parser.parse_args(argv)

    t0 = time.perf_counter()
    out_path = args.output or Path(f"{args.name}.ttf")
    try:
        result = fit_merge_to_file(
            args.font_a, args.font_b, out_path,
            name=args.name, style=args.style,
            korean_scale=args.korean_scale, width_mult=args.width_mult, ty=args.ty,
            include_hanja=not args.no_hanja, fullwidth_source=args.fullwidth)
    except MergeError as e:
        print(f"오류: {e}", file=sys.stderr)
        return e.code

    elapsed = time.perf_counter() - t0
    print(f"병합 완료: {result['path']} — 패밀리 '{args.name}', {elapsed:.1f}초")
    print(f"  복사 {result['copied']}자 (한자 {result['hanja_copied']}자, 새 글리프 "
          f"{result['glyphs_added']}개) · 자동 축소 {result['capped']}개 · "
          f"라틴 {result['latin_advance']} / 한글 {result['korean_advance']} 단위 "
          f"(UPM {result['upem']})")
    for warning in result["warnings"]:
        print(f"  경고: {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
