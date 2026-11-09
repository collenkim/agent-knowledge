# agent-knowledge

master-agent와 code-agent가 각자의 역할에 필요한 지식을 검색하고 출처가 있는 근거를 받아 가는 공용 지식 검색 프로젝트다.

등록된 로컬 Git 저장소의 Markdown 문서를 절·항목 단위로 나누어 SQLite에 색인하고, 프로젝트와 버전으로 범위를 제한한 키워드 검색 결과를 JSON으로 돌려준다. 결과의 모든 항목에는 원본 경로, 줄 범위, 기준 커밋, 내용 해시, 지식 상태와 그 근거가 붙는다.

## 두 에이전트와의 역할 관계

| 구성 요소 | 맡는 일 |
|---|---|
| agent-knowledge | 두 에이전트의 판단에 쓸 근거 제공 |
| master-agent | 목표 분해, 프로젝트 배정, 의존성과 실행 순서 조정, 전체 완료 판단 |
| code-agent | 담당 프로젝트의 요구 분석, 설계, 구현, 테스트, 리뷰 |

맡는 일과 맡지 않는 일은 [docs/scope.md](docs/scope.md)에, 연결 계약은 [docs/integration.md](docs/integration.md)에 있다.

## 설치

Node.js `>=24.19.0 <25`와 Git이 필요하다.

```
npm ci
npm run build
```

CLI 진입점은 `dist/src/cli/main.js`다. 저장소 안에서는 `node dist/src/cli/main.js <명령>` 또는 `npx --no-install agent-knowledge <명령>`으로 실행한다.

## 설정

예시를 복사해 로컬 설정을 만들고 원본 저장소 경로를 고친다. `config/sources.yaml`과 색인 DB(`.data/knowledge.sqlite`)는 Git에서 제외된다.

```
cp config/sources.example.yaml config/sources.yaml
```

필드 설명은 [config/sources.example.yaml](config/sources.example.yaml)의 주석과 [docs/knowledge-model.md](docs/knowledge-model.md#원본)에 있다.

- 예시의 `order-api`는 형식을 보이기 위한 값이므로 실제 저장소로 바꾸어야 `validate`가 통과한다.
- 원본의 `path`는 Git 저장소의 최상위여야 한다. 아니면 `validate`가 `not-git-toplevel` 오류를 낸다.
- 규칙의 `status`와 `basis`는 특정 문서에 대해 운영자가 의도적으로 쓰는 선언이다. 쓰면 그 문서의 항목이 `confirmed:true`로 나가므로 문서를 직접 확인한 경우에만 쓴다.

## 색인과 검색

```
node dist/src/cli/main.js validate
node dist/src/cli/main.js index
node dist/src/cli/main.js status --pretty
node dist/src/cli/main.js search --profile code --project order-api --query "주문 취소" --phase implement --pretty
node dist/src/cli/main.js search --profile master --project order-api --project shared --query "프로젝트 책임" --pretty
node dist/src/cli/main.js get --id "<items[].id 값>" --profile code --project order-api --pretty
```

검색 범위 규칙, 결과 형식, 전체 문법, 종료 코드는 [docs/retrieval.md](docs/retrieval.md)에 있다.

## 평가

```
npm run eval
```

`evals/master`와 `evals/code`의 평가 묶음을 실행한다. 원본은 `evals/fixtures/sample-workspace`의 테스트용 자료이고, 실행할 때 OS 임시 디렉터리에 Git 저장소와 DB를 만들어 쓴 뒤 지운다. 외부 모델 호출이나 네트워크는 필요 없다. 이 평가는 키워드 검색과 범위·상태 규칙만 재며 실제 프로젝트 자료에 대한 품질을 나타내지 않는다.

## 이번 버전의 구현 범위와 한계

항목별 상태는 [docs/scope.md](docs/scope.md#구현-범위)에 있다.

- **구현**: 선택한 커밋의 추적 Markdown 수집과 절·항목 분할, SQLite·FTS5 색인과 증분 갱신, master / code 프로필의 범위 제한 키워드 검색, 지식 상태와 충돌 판정, 출처를 포함한 JSON 결과, CLI와 라이브러리 API, 테스트용 자료 평가
- **인터페이스·설정만**: Qdrant 실행 구성(`compose.yaml`), 벡터 저장소와 임베딩 제공자 인터페이스, 모델 호환성 검사 함수
- **후속**: 벡터 검색과 품질 평가, 커밋되지 않은 작업 트리 색인, 적용 조건 자동 평가, 두 에이전트와의 실제 연동

한계는 다음과 같다.

- 커밋하지 않은 변경은 결과에 반영되지 않는다.
- 검색은 키워드 방식이다. 한국어는 조사 제거와 음절 바이그램으로 처리하며 형태소 분석을 하지 않는다. 벡터 검색 품질은 측정하지 않았다.
- 적용 조건 문장은 기록해서 돌려주기만 하고 자동으로 판정하지 않는다.
- 상태와 충돌은 작성자의 선언, 운영자 규칙, 해석 가능한 근거 참조, 명시적 대체 선언으로만 정한다. 정책과 코드의 차이를 내용으로 추론하지 않는다. 판정 규칙은 [docs/knowledge-model.md](docs/knowledge-model.md#상태)에 있다.

이 저장소에서 작업할 때는 [AGENTS.md](AGENTS.md)를 따른다.
