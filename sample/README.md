# 샘플 폰트

개발·테스트용 샘플 폰트 모음. **이 디렉터리의 폰트는 앱 배포물(설치 파일)에 포함되지 않으며**, 저장소에서의 재배포는 각 폰트의 SIL Open Font License 1.1 조건을 따른다 (동봉된 `LICENSE-*.txt` 참고).

| 파일 | 출처 | 버전 | 라이선스 | Reserved Font Name |
|---|---|---|---|---|
| `D2Coding-Ver1.3.2-20180524.ttf` | [naver/d2codingfont](https://github.com/naver/d2codingfont) | 1.3.2 (2018-05-24) | [OFL 1.1](LICENSE-D2Coding.txt) | D2Coding, D2Coding-Bold |
| `JetBrainsMono-Regular.ttf` | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) | 2.304 | [OFL 1.1](LICENSE-JetBrainsMono.txt) | (없음) |

## 정책

- 위 허용 목록 외의 폰트는 **로컬 전용**이다 — 추가 테스트 폰트를 이 디렉터리에 두는 것은 자유지만 커밋하지 않는다. 루트 `.gitignore`가 화이트리스트 방식(`sample/*` 무시 + 허용 파일만 예외)으로 이를 강제한다.
- OFL 폰트를 새로 커밋하려면: 폰트 파일 + 공식 라이선스 사본(`LICENSE-<이름>.txt`)을 함께 추가하고 이 표를 갱신한 뒤, `.gitignore`의 예외 목록에 두 파일을 등록한다.
- OFL의 Reserved Font Name은 파생 폰트 이름에 재사용할 수 없다 — 병합 결과물의 출력 이름을 정할 때 주의.
