"""font-moeum 코딩 폰트 병합 엔진 (fitmerge).

고정폭 영문 TTF(A)를 베이스로 열고, 한글 TTF(B)의 CJK 글리프를 펜 파이프라인으로
스케일·중앙정렬해 A에 복사한다 (kuskhan/jetendard 방식). fontTools Merger를 쓰는
merge.py와 달리 A의 테이블(GSUB 리가처·힌팅·세로 메트릭)을 그대로 보존하고,
한글은 라틴 폭의 정수배 셀에 맞춰 들어간다 — 터미널/에디터용 코딩 폰트 특화.

- A는 고정폭(모노스페이스) 필수 — check_monospace()로 검증
- 한글 폭 = 라틴 폭 × width_mult (기본 2배), 셀 밖으로 나가면 자동 축소(capped)
- unitsPerEm은 A 기준 — scale_upem 대신 좌표 변환(펜)에 UPM 비율을 흡수
- 조합형 자모(U+1100–)는 B에 글리프가 없어도 호환 자모(U+3130–) 글리프로 폴백
- 조합형 자모 L+V(+T)는 GSUB ccmp 리가처로 완성형 음절에 합성 (jamo_ccmp)
- name 재작성·스타일 비트는 merge.py의 rewrite_names/apply_style_bits 재사용

사용 예:
    uv run fitmerge.py a.ttf b.ttf --name "MyMono" --korean-scale 1.15 -o out.ttf
"""

import argparse
import sys
import time
import unicodedata
from copy import deepcopy
from pathlib import Path

from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.misc.roundTools import otRound
from fontTools.otlLib.builder import buildLigatureSubstSubtable, buildLookup
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables import otTables as ot

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


# 한글 음절 합성 공식: 음절 = 0xAC00 + (L×21 + V)×28 + T
#   L = 초성 인덱스 0–18  (U+1100–1112)
#   V = 중성 인덱스 0–20  (U+1161–1175)
#   T = 종성 인덱스 1–27  (U+11A8–11C2, 0 = 종성 없음)
_JAMO_L_BASE, _JAMO_L_COUNT = 0x1100, 19
_JAMO_V_BASE, _JAMO_V_COUNT = 0x1161, 21
_JAMO_T_BASE, _JAMO_T_COUNT = 0x11A7, 28   # T 인덱스 1부터 — U+11A7+T
_HANGUL_SYL_BASE = 0xAC00


def _jamo_ccmp_rules(cmap: dict) -> dict[tuple[str, ...], str]:
    """조합형 자모 L+V(+T) → 완성형 음절 리가처 매핑을 만든다.

    입력 글리프는 병합 결과 cmap에서 자모 코드포인트가 가리키는 글리프,
    출력 글리프는 음절 코드포인트의 글리프. 넷(L·V·T·음절) 중 하나라도
    cmap에 없으면 그 규칙은 건너뛴다. 같은 글리프 열이 두 번 나오면(비정상
    cmap) 먼저 만든 규칙을 유지한다.
    """
    rules: dict[tuple[str, ...], str] = {}
    for li in range(_JAMO_L_COUNT):
        l_glyph = cmap.get(_JAMO_L_BASE + li)
        if l_glyph is None:
            continue
        for vi in range(_JAMO_V_COUNT):
            v_glyph = cmap.get(_JAMO_V_BASE + vi)
            if v_glyph is None:
                continue
            syl_base = _HANGUL_SYL_BASE + (li * _JAMO_V_COUNT + vi) * _JAMO_T_COUNT
            syl_glyph = cmap.get(syl_base)
            if syl_glyph is not None:
                rules.setdefault((l_glyph, v_glyph), syl_glyph)
            for ti in range(1, _JAMO_T_COUNT):
                t_glyph = cmap.get(_JAMO_T_BASE + ti)
                if t_glyph is None:
                    continue
                syl_glyph = cmap.get(syl_base + ti)
                if syl_glyph is not None:
                    rules.setdefault((l_glyph, v_glyph, t_glyph), syl_glyph)
    return rules


def _new_langsys():
    langsys = ot.LangSys()
    langsys.LookupOrder = None
    langsys.ReqFeatureIndex = 0xFFFF
    langsys.FeatureIndex = []
    langsys.FeatureCount = 0
    return langsys


def _append_ccmp_to_gsub(font, rules: dict) -> None:
    """기존 GSUB에 ccmp 리가처 룩업을 append한다 — 기존 구조는 인덱스 불변.

    degrade 안전 순서: (1) 룩업을 폰트와 무관하게 완성 → (2) GSUB 사본에만
    연결 → (3) 시험 컴파일 통과 후에야 사본을 폰트에 반영. 어느 단계에서
    실패해도 원본 GSUB은 그대로다. feaLib 재빌드는 기존 룩업을 교체해
    리가처(calt/liga)를 죽이므로 절대 쓰지 않는다.
    """
    # (1) LookupType 4 룩업 — buildLigatureSubstSubtable이 같은 첫 글리프의
    # 리가처를 긴 성분 우선(L+V+T가 L+V보다 앞)으로 정렬한다.
    lookup = buildLookup([buildLigatureSubstSubtable(rules)])

    # (2) 사본에서 연결 — 룩업·피처는 각 리스트 끝에 append해 기존 인덱스 보존
    gsub = font["GSUB"]
    original = gsub.table
    work = deepcopy(original)

    if work.LookupList is None:
        work.LookupList = ot.LookupList()
        work.LookupList.Lookup = []
    lookup_index = len(work.LookupList.Lookup)
    work.LookupList.Lookup.append(lookup)
    work.LookupList.LookupCount = len(work.LookupList.Lookup)

    if work.FeatureList is None:
        work.FeatureList = ot.FeatureList()
        work.FeatureList.FeatureRecord = []
    ccmp_features = []
    seen = set()  # 레코드끼리 Feature 객체를 공유해도 이중 append 방지
    for record in work.FeatureList.FeatureRecord:
        if record.FeatureTag == "ccmp" and id(record.Feature) not in seen:
            seen.add(id(record.Feature))
            ccmp_features.append(record.Feature)

    if ccmp_features:
        # 기존 ccmp Feature 전부에 추가 — 스크립트/언어별 레코드가 나뉘어
        # 있어도(JetBrains Mono가 그렇다) 모든 langsys에서 켜진다.
        for feature in ccmp_features:
            feature.LookupListIndex.append(lookup_index)
            feature.LookupCount = len(feature.LookupListIndex)
    else:
        # 새 FeatureRecord — 태그 정렬 대신 끝에 append: 중간 삽입은 기존
        # FeatureIndex 참조를 전부 밀어 깨뜨린다 (시험 컴파일로 허용 확인).
        record = ot.FeatureRecord()
        record.FeatureTag = "ccmp"
        record.Feature = ot.Feature()
        record.Feature.FeatureParams = None
        record.Feature.LookupListIndex = [lookup_index]
        record.Feature.LookupCount = 1
        feature_index = len(work.FeatureList.FeatureRecord)
        work.FeatureList.FeatureRecord.append(record)
        work.FeatureList.FeatureCount = len(work.FeatureList.FeatureRecord)

        # 모든 Script의 DefaultLangSys·모든 LangSysRecord에 등록 — ccmp는
        # 어느 스크립트에서든 켜져야 하므로 전부 등록이 단순하고 안전.
        if work.ScriptList is None:
            work.ScriptList = ot.ScriptList()
            work.ScriptList.ScriptRecord = []
        if not work.ScriptList.ScriptRecord:
            script_record = ot.ScriptRecord()
            script_record.ScriptTag = "DFLT"
            script_record.Script = ot.Script()
            script_record.Script.DefaultLangSys = _new_langsys()
            script_record.Script.LangSysRecord = []
            script_record.Script.LangSysCount = 0
            work.ScriptList.ScriptRecord.append(script_record)
        work.ScriptList.ScriptCount = len(work.ScriptList.ScriptRecord)
        for script_record in work.ScriptList.ScriptRecord:
            script = script_record.Script
            langsys_all = [script.DefaultLangSys] if script.DefaultLangSys else []
            langsys_all += [r.LangSys for r in getattr(script, "LangSysRecord", None) or []]
            for langsys in langsys_all:
                langsys.FeatureIndex.append(feature_index)
                langsys.FeatureCount = len(langsys.FeatureIndex)

    # (3) 시험 컴파일 — 실패하면 원본으로 되돌리고 예외 전파 (반쯤 수정 금지)
    gsub.table = work
    try:
        gsub.compile(font)
    except Exception:
        gsub.table = original
        raise


def _build_gsub_with_fea(font, rules: dict) -> None:
    """GSUB이 없는 폰트에 feaLib으로 ccmp만 담은 GSUB을 신규 생성한다."""
    lines = [
        "languagesystem DFLT dflt;",
        "languagesystem latn dflt;",
        "languagesystem hang dflt;",
        "feature ccmp {",
    ]
    lines += [f"    sub {' '.join(components)} by {lig};"
              for components, lig in rules.items()]
    lines.append("} ccmp;")
    try:
        addOpenTypeFeaturesFromString(font, "\n".join(lines), tables=["GSUB"])
    except Exception:
        if "GSUB" in font:
            del font["GSUB"]  # 반쯤 만들어진 테이블을 남기지 않는다
        raise


def _add_jamo_ccmp(font, cmap: dict) -> int:
    """병합 폰트에 자모 합성 ccmp를 추가하고 생성한 규칙 수를 반환한다.

    실패 시 예외를 던지되 GSUB은 원본(또는 부재) 상태를 유지한다.
    """
    rules = _jamo_ccmp_rules(cmap)
    if not rules:
        return 0
    if "GSUB" in font:
        _append_ccmp_to_gsub(font, rules)
    else:
        _build_gsub_with_fea(font, rules)
    return len(rules)


# 소스 글리프 분석(기록+바운즈)은 korean_scale/ty/width_mult와 무관하게 B의
# 아웃라인에만 의존한다 → persistent 사이드카에서 B 신원별로 캐시해 재조정 루프의
# 지배적 비용(기록 ~3s + 바운즈 ~0.6s)을 재병합마다 건너뛴다. 단일 엔트리(B가
# 바뀌면 통째 교체)로 메모리를 바운드한다.
_analysis_cache: dict = {"key": None, "data": None}


def _analyze_source(glyphset, src) -> tuple:
    """소스 글리프를 1회 기록(컴포지트 평탄화)하고 바운딩 박스를 잰다.

    반환 (recording, bounds) — scale과 무관하므로 캐시 가능. RecordingPen.replay는
    self.value를 읽기만 하고 변형하지 않으므로, 같은 recording을 여러 병합에서
    서로 다른 TransformPen으로 재생해도 안전하다.
    """
    recording = DecomposingRecordingPen(glyphset, skipMissingComponents=True)
    glyphset[src].draw(recording)
    bounds_pen = BoundsPen(None)
    recording.replay(bounds_pen)
    return recording, bounds_pen.bounds


def fit_merge_to_file(font_a, font_b, output, *, name="MoeumMono", style="Regular",
                      korean_scale=1.15, width_mult=2.0, ty=0.0,
                      include_hanja=True, fullwidth_source="B",
                      jamo_ccmp=True) -> dict:
    """A(고정폭 라틴)에 B의 CJK 글리프를 셀에 맞춰 복사해 output에 저장한다.

    반환: {"path", "copied", "capped", "glyphs_added", "latin_advance",
           "korean_advance", "upem", "hanja_copied", "ccmp_rules", "warnings"}
    실패 시 MergeError. jamo_ccmp=True면 조합형 자모 L+V(+T)를 완성형 음절로
    합성하는 GSUB ccmp 리가처를 추가한다 (실패해도 병합은 성공, ccmp_rules=0).
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

    # B 신원별 분석 캐시 — mtime_ns+size로 내용 변경 감지(같은 경로에 B가 재업로드돼도
    # 무효화). include_hanja/fullwidth는 키에 넣지 않는다 — 어떤 글리프를 emit할지만
    # 바꿀 뿐 개별 글리프의 기록·바운즈는 불변이므로 아래 지연 채움이 알아서 처리한다.
    st = font_b_path.stat()
    cache_key = (str(font_b_path.resolve()), st.st_mtime_ns, st.st_size)
    if _analysis_cache["key"] != cache_key:
        _analysis_cache["key"] = cache_key
        _analysis_cache["data"] = {}
    analysis = _analysis_cache["data"]   # {src_glyph_name: (recording, bounds)}

    source_cache: dict[str, str] = {}  # B 소스 글리프 이름 → 새 글리프 이름
    cmap_updates: dict[int, str] = {}
    copied = capped = glyphs_added = hanja_copied = 0

    for cp, src, category in plan:
        new_name = source_cache.get(src)
        if new_name is None:
            new_name = _unique_name(cp, existing)

            # 캐시 조회 — 없으면 지연 채움(필요한 글리프만 분석해 캐시에 채운다)
            cached = analysis.get(src)
            if cached is None:
                cached = _analyze_source(glyphset_b, src)
                analysis[src] = cached
            recording, bounds = cached

            tt_pen = TTGlyphPen(None)
            if bounds is None:
                # 빈 글리프 (예: U+3000 전각 공백) — 윤곽 없이 폭만 등록
                glyph = tt_pen.glyph()
                lsb = 0
            else:
                xmin, ymin, xmax, ymax = bounds
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

    # --- 4. 조합형 자모 ccmp — L+V(+T) → 완성형 음절 리가처 (GSUB) ---
    # 매핑이 확정된 cmap 갱신 뒤, 이름 재작성 전에 실행. 어떤 예외가 나도
    # 병합 자체는 성공해야 하므로 degrade: 경고만 남기고 GSUB은 원본 유지.
    ccmp_rules = 0
    if jamo_ccmp:
        final_cmap = dict(cmap_a)
        final_cmap.update(cmap_updates)
        try:
            ccmp_rules = _add_jamo_ccmp(font_a, final_cmap)
        except Exception as e:
            warnings.append(
                f"자모 조합(ccmp) 생성 실패: {e} — 이 기능 없이 저장합니다")

    # --- 5. 후처리 ---
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
        "ccmp_rules": ccmp_rules,
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
    parser.add_argument("--no-ccmp", action="store_true",
                        help="조합형 자모 합성(GSUB ccmp) 생성 생략")
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
            include_hanja=not args.no_hanja, fullwidth_source=args.fullwidth,
            jamo_ccmp=not args.no_ccmp)
    except MergeError as e:
        print(f"오류: {e}", file=sys.stderr)
        return e.code

    elapsed = time.perf_counter() - t0
    print(f"병합 완료: {result['path']} — 패밀리 '{args.name}', {elapsed:.1f}초")
    print(f"  복사 {result['copied']}자 (한자 {result['hanja_copied']}자, 새 글리프 "
          f"{result['glyphs_added']}개) · 자동 축소 {result['capped']}개 · "
          f"자모 조합 {result['ccmp_rules']}규칙 · "
          f"라틴 {result['latin_advance']} / 한글 {result['korean_advance']} 단위 "
          f"(UPM {result['upem']})")
    for warning in result["warnings"]:
        print(f"  경고: {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
