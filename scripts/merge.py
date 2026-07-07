"""font-moa 병합 엔진 스켈레톤.

실제 병합 로직(TTF 검증 → scale_upem → Merger → name 재작성)은 Phase 2에서 구현한다.
지금은 환경 확인용: fonttools import와 CLI 뼈대가 에러 없이 도는 것까지만.
"""

import argparse
import sys

from fontTools import version as fonttools_version

# 사이드카 I/O는 콘솔 코드페이지(Windows cp949 등)와 무관하게 UTF-8 고정.
# Phase 3의 stdin/stdout 프로토콜도 이 전제를 따른다.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="merge.py",
        description="영문 TTF(A) + 한글 TTF(B)를 하나의 TTF로 병합한다. (Phase 2에서 구현 예정)",
    )
    parser.parse_args(argv)
    print(f"font-moa merge engine — 스켈레톤 (fonttools {fonttools_version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
