# font-moeum (모음) — 앱 아이콘 세트

마크: **M + ㅗ = 모** — 영문 자음 M(=한글 ㅁ)과 한글 모음 ㅗ를 한 글자로 합성.
이름 첫 글자이자, 이 툴이 하는 일(영문+한글 폰트 합성) 그 자체입니다.

- 색: 배경 Dracula 다크 그라디언트(#2b2d3c → #191a21), 마크 #f5f1e8
- 형태: 라운드 스퀘어(코너 반경 224/1024 ≈ 22%), 코너 바깥은 투명

## 파일

| 파일 | 용도 |
|---|---|
| `icon.svg` | 벡터 마스터 (폰트 의존성 없음, 편집·재출력용) |
| `icon.png` | 1024×1024 래스터 원본 (`tauri icon`의 소스) |
| `icon.ico` | Windows (16·24·32·48·64·128·256 멀티 해상도 내장) |
| `icon.icns` | macOS (16~1024, @2x 포함) |
| `32x32.png`, `128x128.png`, `128x128@2x.png` | Tauri 기본 PNG |
| `Square*Logo.png`, `StoreLogo.png` | Windows Store 패키징용 |

## Tauri에 적용

**방법 A — 파일 그대로 사용 (권장)**
이 폴더의 파일 이름은 Tauri 기본값과 동일합니다. `src-tauri/icons/` 안의 내용물을 이 파일들로 교체하세요.
`tauri.conf.json`의 `bundle.icon` 기본 목록이 이미 이 이름들을 가리킵니다:

```json
"bundle": {
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico"
  ]
}
```

**방법 B — 원본에서 재생성**
1024 원본으로 전 플랫폼 아이콘을 다시 뽑고 싶으면:

```bash
npm run tauri icon icons/icon.png
# 또는
cargo tauri icon icons/icon.png
```

> 참고: `128x128@2x.png`는 파일 이름의 `@2x`가 그대로 있어야 Tauri가 인식합니다.
> 색/굵기/여백을 바꾸려면 `icon.svg`를 편집한 뒤 방법 B로 재생성하면 됩니다.
