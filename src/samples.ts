/**
 * 폰트 미리보기 샘플 모음
 *
 * 타깃: IDE 사용자(개발자). 그래서 팬그램이 아니라 "코드".
 * 이 툴은 영문+한글 머지 → 샘플은 "라틴 코드(폰트 A) + 한글 주석(폰트 B)"
 * 조합으로, 두 폰트가 한 화면에서 섞이는 걸 즉시 보여준다.
 *
 * 각 샘플은 폰트 감별에 중요한 글리프를 의도적으로 품고 있음:
 *   0 vs O · 1 vs l vs I vs | · => -> != === >= <= |> :: 등
 */

export interface FontSample {
  id: string;
  label: string;
  lang: string;   // 신택스 하이라이팅 언어 힌트
  code: string;
}

export const FONT_SAMPLES: FontSample[] = [
  {
    id: "rust_merge",
    label: "병합 함수 (기본값)",
    lang: "rust",
    // 셀프 레퍼런셜: 머지 툴 안의 머지 함수. 설명은 코드가 한다.
    code: `fn merge<T: Ord + Copy>(a: &[T], b: &[T]) -> Vec<T> {
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::with_capacity(a.len() + b.len());
    while i < a.len() && j < b.len() {
        // 겹치면 왼쪽(A)이 이긴다
        if a[i] <= b[j] { out.push(a[i]); i += 1; }
        else            { out.push(b[j]); j += 1; }
    }
    out.extend_from_slice(&a[i..]);
    out.extend_from_slice(&b[j..]);
    out
}`,
  },
  {
    id: "quake_rsqrt",
    label: "고속 역제곱근 (Quake III)",
    lang: "c",
    // 게임/그래픽스 개발자 즉시 알아보는 전설의 코드. 매직 넘버 0x5f3759df.
    // 인라인 주석은 원전(evil floating point bit level hacking)의 번역이라 유지.
    code: `float Q_rsqrt(float number) {
    long  i;
    float x2 = number * 0.5F, y = number;
    i = * ( long  * ) &y;              // 사악한 부동소수점 비트 해킹
    i = 0x5f3759df - ( i >> 1 );       // 대체 이게 무슨 마법이지?
    y = * ( float * ) &i;
    y = y * ( 1.5F - ( x2 * y * y ) ); // 뉴턴-랩슨 1회 반복
    return y;
}`,
  },
  {
    id: "haskell_qsort",
    label: "우아한 퀵정렬 (Haskell)",
    lang: "haskell",
    // 한 줄의 시. 함수형 감성 + 리스트 컴프리헨션의 기호들.
    code: `-- 하스켈 퀵정렬: 선언적이라 거의 정의를 그대로 옮긴 수준
quicksort :: Ord a => [a] -> [a]
quicksort []     = []
quicksort (p:xs) = quicksort [x | x <- xs, x <  p]  -- 피벗보다 작은 것
                ++ [p]                              -- 피벗
                ++ quicksort [x | x <- xs, x >= p]  -- 크거나 같은 것`,
  },
  {
    id: "y_combinator",
    label: "Y 콤비네이터 (람다 계산법)",
    lang: "javascript",
    // 이름 없는 재귀. 화살표(=>)를 대량으로 씀 → 리가처 확인에 최적.
    code: `// Y 콤비네이터 — 익명 함수만으로 재귀를 만든다 (람다 계산법)
const Y = f => (x => f(v => x(x)(v)))(x => f(v => x(x)(v)));

const fact = Y(self => n => (n <= 1 ? 1 : n * self(n - 1)));
console.log(fact(5)); // => 120, 이름 없이도 자기 자신을 부른다`,
  },
  {
    id: "glyph_test",
    label: "글리프 감별 (torture test)",
    lang: "text",
    // 있어보이는 용도 아님 — 순수하게 폰트를 괴롭혀 차이를 드러내는 용도.
    code: `모호한 글자   0O0 oO · 1lI| · rn/m · cl/d · B8 · 5S · 2Z · G6
따옴표/기호    'quote' \`tick\` "double" · ~-_ · {}[]() · <>/\\ · @#$%^&*
리가처 후보    => -> <- == === != !== >= <= |> <| :: ++ -- // /* */ && ||
한영 혼용      안녕하세요 Hello 반갑습니다 World 한글과 English 123 混用
연속 한글      가나다라마바사 아자차카타파하 · 곬 없 뷁 쏵 (받침 조합)`,
  },
];

/** 기본으로 보여줄 샘플 (병합 함수 = 셀프 레퍼런셜 + 한영 혼용) */
export const DEFAULT_SAMPLE = FONT_SAMPLES[0];
