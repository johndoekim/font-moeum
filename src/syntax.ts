// ── 원샷 신택스 하이라이터 ──────────────────────────────────────
// 초기 렌더에만 적용되는 가벼운 토크나이저 (Dracula: 주석 파랑, 문자열 노랑,
// 숫자 보라, 키워드/연산자 핑크). 편집을 시작하면 그 줄부터는 점차 평문화되는데,
// 미리보기의 목적은 폰트 감별이므로 의도적으로 여기까지만 한다.

const COMMENT_MARKER: Record<string, string> = {
  rust: "//",
  c: "//",
  javascript: "//",
  haskell: "--",
};

const KEYWORDS: Record<string, Set<string>> = {
  rust: new Set(["fn", "let", "mut", "for", "in", "while", "if", "else", "return", "const", "use"]),
  c: new Set(["float", "long", "const", "return"]),
  javascript: new Set(["const", "return"]),
};

export const LANG_NAME: Record<string, string> = {
  rust: "Rust",
  c: "C",
  haskell: "Haskell",
  javascript: "JavaScript",
  text: "Plain Text",
};

const TOKEN_RE = /(["'`])(?:\\.|(?!\1).)*?\1|0x[0-9A-Fa-f]+|\d+(?:\.\d+)?F?|[A-Za-z_$][\w$]*|[=!<>+\-*/&|:%^~?]+/g;

export interface Token {
  text: string;
  cls?: string;
}

export function tokenizeLine(line: string, lang: string): Token[] {
  const marker = COMMENT_MARKER[lang];
  if (!marker) return [{ text: line }]; // text 등: 하이라이팅 없이 순수 폰트 감별용
  const commentIdx = line.indexOf(marker);
  const code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;

  const tokens: Token[] = [];
  const keywords = KEYWORDS[lang];
  let last = 0;
  for (const m of code.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (start > last) tokens.push({ text: code.slice(last, start) });
    const text = m[0];
    let cls: string | undefined;
    if (/^["'`]/.test(text)) cls = "tok-string";
    else if (/^(0x|\d)/.test(text)) cls = "tok-number";
    else if (/^[A-Za-z_$]/.test(text)) cls = keywords?.has(text) ? "tok-keyword" : undefined;
    else cls = "tok-op";
    tokens.push({ text, cls });
    last = start + text.length;
  }
  if (last < code.length) tokens.push({ text: code.slice(last) });
  if (commentIdx >= 0) tokens.push({ text: line.slice(commentIdx), cls: "tok-comment" });
  return tokens;
}
