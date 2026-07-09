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
  label: string;      // 한글 설명 — 탭 hover 툴팁·상세용
  filename: string;    // 탭에 보이는 짧은 파일명(모노) — 에디터 느낌으로 폭을 좁게
  lang: string;   // 신택스 하이라이팅 언어 힌트
  code: string;
}

export const FONT_SAMPLES: FontSample[] = [
  {
    id: "preview_rs",
    label: "병합 미리보기 — 한영 혼용 쇼케이스",
    filename: "preview.rs",
    lang: "rust",
    // 이 툴이 뭘 하는지 코드가 스스로 설명한다: 라틴(A)+한글(B) 혼용, 실제 옵션
    // 이름(korean_scale·width_mult·ty)과 완성형 범위(0xAC00–0xD7A3)까지 노출.
    code: `// ── MoeumMono 병합 미리보기 ────────────────────────
// 영문 A가 라틴·숫자·기호를, 한글 B가 나머지를 그린다.

fn main() {
    let latin = "Sphinx of black quartz, judge my vow.";
    let hangul = "다람쥐 헌 쳇바퀴에 타고파";
    let mixed = format!("{latin} · {hangul} · 0123456789");

    // 격자 정렬 — 한글은 라틴 딱 2칸 (width_mult = 2.0)
    for (i, ch) in mixed.chars().enumerate() {
        if i % 2 == 0 { print!("{ch}"); }
    }

    let scale = 1.15;    // korean_scale — 셀에 꽉 차게
    let ty = -0.02;      // 세로 오프셋 (em)
    let start = 0xAC00;  // '가' — 완성형 시작
    let end = 0xD7A3;    // '힣' — 완성형 끝

    assert_eq!(end - start + 1, 11172);
    println!("커버리지 {start:X}..{end:X} 확인");
}`,
  },
  {
    id: "kernel_c",
    label: "고속 역제곱근 (Quake III)",
    filename: "kernel.c",
    // 게임/그래픽스 개발자가 즉시 알아보는 전설의 코드. 매직 넘버 0x5f3759df.
    lang: "c",
    code: `// Q_rsqrt — 비트 해킹으로 1/√x 근사
float Q_rsqrt(float number) {
    long i;
    float x2, y;
    const float threehalfs = 1.5F;

    x2 = number * 0.5F;
    y  = number;
    i  = *(long *) &y;            // 비트를 정수로 재해석
    i  = 0x5f3759df - (i >> 1);   // 마법의 상수
    y  = *(float *) &i;
    y  = y * (threehalfs - (x2 * y * y));
    return y;                     // 뉴턴 1회로 충분
}`,
  },
  {
    id: "fold_hs",
    label: "접기와 합성 (Haskell)",
    filename: "fold.hs",
    // 함수형 감성 — 한글 주석 + 라틴 코드, 타입 시그니처의 기호들.
    lang: "haskell",
    code: `-- 접기와 합성 — 한글 주석, 라틴 코드
sumTo :: Int -> Int
sumTo n = foldr (+) 0 [1..n]

-- 평균: 합계를 길이로 나눈다
mean :: [Double] -> Double
mean xs = sum xs / fromIntegral (length xs)

main :: IO ()
main = print (mean [1.0, 1.5, 2.0])  -- 1.5`,
  },
  {
    id: "pangram_txt",
    label: "팬그램 · 글리프 감별",
    filename: "pangram.txt",
    // 팬그램(영/한) + 숫자·통화 + 감별 글자 + 리가처 후보 대량 라인을 한 화면에.
    lang: "text",
    code: `The quick brown fox jumps over the lazy dog.
Pack my box with five dozen liquor jugs.

다람쥐 헌 쳇바퀴에 타고파
키스의 고유조건은 입술끼리 만나야 하고
정 참판 양반댁 규수 큰 교자 타고 혼례 치른 날

0123456789 ₩1,234,567 3.141592
il1I|! oO0 {}[]()<> · rn/m cl/d B8 5S 2Z G6
=> -> <- == === != !== >= <= |> <| :: ++ -- // /* */ && ||
「모음」 — 영문과 한글이 한 폰트처럼`,
  },
];

/** 기본으로 보여줄 샘플 (preview.rs = MoeumMono 병합 미리보기 쇼케이스) */
export const DEFAULT_SAMPLE = FONT_SAMPLES[0];
