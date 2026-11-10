# agent-knowledge 작업 지침

## 먼저 읽을 문서

1. [README.md](README.md): 목적, 실행 방법
2. [docs/scope.md](docs/scope.md): 맡는 일과 맡지 않는 일, 구현 범위
3. [docs/knowledge-model.md](docs/knowledge-model.md): 원본·분류·상태·출처·버전
4. [docs/retrieval.md](docs/retrieval.md): 검색·필터·필수 근거·결과 구성, CLI, 종료 코드
5. [docs/integration.md](docs/integration.md): 두 에이전트 연결. 확인한 사실과 제안을 구분한다.
6. [knowledge/README.md](knowledge/README.md): 공용 지식 폴더에 둘 것과 두지 말 것

## 코드와 문서의 대응

| 코드 | 문서 |
|---|---|
| `src/model.ts`, `src/parsing/`(`segments.ts` 포함), `src/indexing/resolve.ts` | [docs/knowledge-model.md](docs/knowledge-model.md) |
| `src/sources/`, `config/sources.example.yaml` | [docs/knowledge-model.md](docs/knowledge-model.md) |
| `src/indexing/indexer.ts`, `src/indexing/store.ts`, `src/indexing/schema.ts`, `src/indexing/leases.ts` | [docs/knowledge-model.md](docs/knowledge-model.md) |
| `src/retrieval/`(`units.ts`, `compose-v2.ts`, `verify.ts`, `capabilities.ts` 포함), `src/profiles/`, `config/retrieval.yaml` | [docs/retrieval.md](docs/retrieval.md) |
| `src/cli/`, `src/errors.ts`, `src/index.ts`, `src/util/package-info.ts` | [docs/retrieval.md](docs/retrieval.md) |
| `src/evaluation/`(`ranking.ts`, `ranking-suite.ts` 포함), `evals/` | [docs/retrieval.md](docs/retrieval.md) |
| `src/adapters/`, `compose.yaml` | [docs/scope.md](docs/scope.md) |
| 응답 형식 2의 참조·재현 식별값·세대 고정·임대의 소비자 계약 | [docs/integration.md](docs/integration.md) |

코드를 바꾸면 대응 문서를 같은 변경에서 고친다. 사실 하나는 문서 한 곳에만 적고 다른 곳에서는 링크한다. `tests/docs.test.ts`는 구현된 CLI 명령이나 `ErrorCode`가 [docs/retrieval.md](docs/retrieval.md)에 없을 때, 표의 종료 코드 값이 다를 때, 상대 링크의 대상 파일이 없을 때, 문서 진단 코드·건너뛴 이유·충돌 사유가 [docs/knowledge-model.md](docs/knowledge-model.md)에 없을 때 실패한다. 문서에 남은 오래된 명령이나 코드, 링크의 앵커는 검사하지 않으므로 직접 확인한다.

## 개발과 검증 명령

```
npm ci
npm run build
npm test
npm run eval
```

- 런타임 의존성은 `yaml`, `zod`뿐이다. 정확한 버전으로 고정하고 lockfile을 함께 관리한다.
- 테스트는 오프라인으로 돌아가고 OS 임시 디렉터리에만 쓴다. 외부 유료 모델 호출이나 실제 프로젝트 자료 없이 전체 검증이 끝나야 한다.

## 코드 규칙

- ESM TypeScript이고 상대 import에는 `.js` 확장자를 붙인다. 작은따옴표, 2칸 들여쓰기, LF를 쓴다.
- 코드 주석과 문서는 한국어 해라체로 쓰고, 이유가 드러나지 않는 곳에만 주석을 단다. CLI가 사람에게 보여 주는 문구는 합쇼체로 쓴다. 식별자와 오류 코드는 영어 kebab-case다.
- 정렬은 `src/util/compare.ts`의 `compareStrings`로 한다. `localeCompare`를 쓰면 환경에 따라 결과가 달라져 같은 입력의 출력이 바이트까지 같아야 한다는 조건이 깨진다.
- Git은 `execFileSync('git', ['-C', root, ...], { shell: false })`로 호출한다. `shell: true`를 쓰지 않는다. 자식 환경은 `src/sources/git.ts`의 `gitChildEnv()`로 만들어 상속된 `GIT_DIR` 같은 저장소 지역 변수가 다른 저장소를 가리키지 못하게 한다.
- stdout에는 명령마다 JSON 문서 하나만 쓴다. 진행 상황과 진단은 stderr로 보낸다. `process.exit` 대신 `process.exitCode`를 쓴다.
- 비어 있는 추상 계층이나 쓰이지 않는 구현체를 만들지 않는다.

## 지식 상태·출처·버전을 다룰 때

규칙의 내용은 [docs/knowledge-model.md](docs/knowledge-model.md)에 있다. 코드를 고칠 때는 아래를 지킨다.

- 코드가 스스로 `confirmed_policy`나 `verified_experience`를 부여하지 않는다. 상태 판정은 `src/indexing/resolve.ts`의 `resolveBaseStatus`로만 하고, 근거가 해석되지 않으면 `unverified`로 남긴다. 대체 처리(`applySupersessions`)는 대상을 폐기하거나 충돌로 표시할 뿐 올리지 않는다.
- 판단이 갈리면 확정으로 넘어가지 않는 쪽을 택한다.
- 충돌은 선언, 중복 키, 계약 소유자 중복, 미확정 대체(`unconfirmed-supersession`)로만 판정한다. 내용을 보고 추측하지 않는다.
- 원본 규칙의 `status`, `basis`는 특정 문서에 대한 운영자의 진술이다. 예시 설정에 값으로 넣지 않는다.
- `unverified`, `deprecated`, `conflicted`, `observed_behavior`인 항목은 어떤 경우에도 `confirmed:true`로 내보내지 않는다.
- 범위 밖 항목의 ID, 경로, 프로젝트를 출력에 싣지 않는다. 범위 판정은 `src/retrieval/scope.ts`의 `inEffectiveScope` 한 곳에서 정의한다.
- 결과를 검증 기록이나 증거라고 부르지 않는다. 이 저장소가 돌려주는 것은 근거다. `verify`는 참조 무결성 확인이고 임대는 세대 보호 표시다. 둘 다 승인·완료 상태를 담지 않는다.
- 형식 1 응답(`responseVersion` 생략·`1`)의 출력은 바이트까지 바꾸지 않는다. 새 필드와 정책은 형식 2나 선택 설정으로만 넣고 `tests/compat.test.ts`로 확인한다.
- 범위 밖 항목은 BM25 통계, `budget.omitted`, `verify`의 후보에도 넣지 않는다.
- 원본 저장소에는 절대 쓰지 않는다.
- 해석 규칙을 바꾸면 `src/parsing/versions.ts`의 해당 상수를 올린다. 올리지 않으면 이전 색인이 재사용되어 코드와 색인이 어긋난다. 어떤 상수를 올릴지는 [docs/knowledge-model.md](docs/knowledge-model.md#버전)에 있다.
- SQLite 스키마를 바꾸면 `src/indexing/schema.ts`의 마이그레이션 배열에 항목을 덧붙이고, 테이블을 더했으면 `REQUIRED_TABLES`에도 적는다.

## 자료 규칙

- 실제 프로젝트 정책을 임의로 써 넣지 않는다. 평가 자료는 `evals/fixtures/` 아래에 `fixture: true`와 테스트용 자료 표시를 달아 둔다.
- 벡터 검색 품질이 확인되었다고 쓰지 않는다. 실제 의미 검색을 검증한 뒤에 다룬다.
