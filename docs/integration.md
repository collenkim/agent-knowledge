# 에이전트 연동

인접 저장소를 읽어 **확인한 사실**과 앞으로의 **제안 계약**을 나누어 적는다. 제안 계약은 어느 쪽 저장소에도 구현되어 있지 않다.

## 확인한 사실

2026-11-09에 아래 커밋의 파일을 읽어 확인했다. 참조는 각 저장소 기준의 `경로:줄`이다. code-agent 작업 트리에는 커밋되지 않은 변경이 있지만 인용한 파일에는 변경이 없다.

| 저장소 | 읽은 커밋 |
|---|---|
| master-agent | `38a06d5c7fa8487719cc93140ad3252eb0d268b7` |
| code-agent | `182d49f48257d0c37bedb1907562b70f747e734c` |

### master-agent

**수집 단위**

- 근거 종류는 `overview`, `policy`, `contract`, `code`, `plan`, `experience` 여섯 가지다 (`packages/knowledge/sources.mjs:6`).
- 수집 목록은 `{schemaVersion:1, sources:[{path, kind}]}`이고 최대 32개다 (`packages/knowledge/sources.mjs:109`).
- 소스 ID는 `source:<projectId>:<encodeURIComponent(path)>@<digest>`이다 (`packages/knowledge/sources.mjs:78`).
- `digest`는 `hash(bytes.toString('base64'))`이고 `hash`는 값을 `canonical`로 직렬화한 뒤 SHA-256을 낸다. 파일 바이트의 단순 SHA-256이 아니다 (`packages/knowledge/sources.mjs:76`, `packages/domain/contracts.mjs:21-26`).
- 스냅샷 ID는 `knowledge:<projectId>:<digest>`이다 (`packages/knowledge/sources.mjs:119-120`).
- 소스는 파일 단위다. 일반 파일 경로만 받고 같은 파일을 중복 지정할 수 없어서, 문서의 절을 소스로 넣을 수 없다 (`packages/knowledge/sources.mjs:59,109,113`).

**검색과 계획 입력**

- `Knowledge.search`는 소문자 비교로 줄 단위 부분 문자열을 OR로 찾으며 (`packages/knowledge/sources.mjs:150-156`), CLI `project search`에서만 쓴다 (`apps/cli/main.mjs:230`).
- 계획 AI 호출에는 도구와 MCP가 없다 (`packages/reasoning/cli-provider.mjs:43-52`, `docs/ai-planning.md:83`). 그러므로 검색은 AI 호출 전에 끝나야 한다.
- 계획의 참조는 닫혀 있다. 이번 context의 `sources[]`에 있는 ID만 고를 수 있고 (`packages/reasoning/schema.mjs:29-37`, `packages/reasoning/planner.mjs:67-72`), 계획 검증은 `project.references`에 등록된 값만 받는다 (`packages/domain/contracts.mjs:69`).
- 계획 context는 해시로 고정된다. 분석 기록에 `contextHash`를 저장하고 (`packages/reasoning/planner.mjs:213-215`), 복구 시 해시가 다르면 적용하지 않으며 (`packages/reasoning/planner.mjs:126`), 재수집한 스냅샷 ID가 달라지면 `stale-knowledge`로 실패한다 (`packages/reasoning/planner.mjs:146-148`).
- 임무 중 근거가 달라진 `project collect`는 프로젝트를 저장해 revision을 올리고 (`packages/knowledge/sources.mjs:124-129`, `packages/storage/store.mjs:83`), 계획의 프로젝트 버전과 달라지면 `stale-context`로 실패한다 (`packages/orchestrator/live.mjs:56,85`).

**code-agent로의 인계**

- 인계는 프롬프트 문자열 하나다 (`packages/runner/host-context.mjs:18-48`). 길이 상한 20000자는 받는 쪽인 code-agent에 있다 (code-agent `src/agent/master/control.ts:38,219`).
- 프롬프트에 수집한 근거 본문은 없다. 지식은 `task`의 `references`에 소스 ID 문자열로만 간다 (`packages/runner/host-context.mjs:26`, `packages/domain/contracts.mjs:63`). 예외로 선행 작업의 문서 계약은 `dependencyContracts`와 `contractDocuments`로 문장까지 간다 (`packages/runner/host-context.mjs:19-20,27-28`).
- `dependencyContracts`의 형식은 `{version:1, contracts:[{id, repository, path, commit, sha256, claims:[{key, text}]}]}`이다 (`packages/verification/handoff-contracts.mjs:15-24`). 이 `sha256`은 파일 바이트의 단순 SHA-256이다 (`packages/verification/handoff-contracts.mjs:33`).

**실행 환경 관례**

- 작업 트리 스냅샷은 추적 파일과 무시되지 않은 미추적 파일을 해시한다 (`packages/verification/tree.mjs:24-44`). 원본 저장소에 파일이 생기면 스냅샷이 달라진다.
- CLI는 `parseArgs` strict를 쓰고 (`apps/cli/main.mjs:134`), 성공 결과는 stdout에 JSON으로 쓰고 (`apps/cli/main.mjs:347`), 오류는 stderr에 `{error, message}` JSON을 쓰고 종료 코드 1로 끝난다 (`apps/cli/main.mjs:351-352`). 오류 코드는 kebab-case다 (`packages/domain/contracts.mjs:3-8`).
- code-agent 제어 응답은 stdout의 마지막 줄을 JSON으로 읽는다 (`packages/code-agent-adapter/control.mjs:29`).
- 프로젝트 ID는 비어 있지 않은 문자열이면 되고 형식 제약이 없다 (`packages/domain/contracts.mjs:29-34`). Windows에서 프로젝트 경로는 소문자로 비교한다 (`packages/domain/paths.mjs:3-6`).
- 수집 경로 차단 목록은 `packages/knowledge/sources.mjs:7-8`에 있다.
- 코드에서 근거는 수집한 자료(`packages/knowledge/sources.mjs:68`), 증거는 선행 작업의 검증 기록(`packages/runner/host-context.mjs:8`)을 뜻한다.

### code-agent

**단계와 문서 위치**

- 단계는 `analysis`, `impact`, `design`, `plan`, `implement`, `check`, `test`, `review`, `integrate`, `deliver`다 (`src/agent/layout.ts:27-38`). `repro`는 검증 기록의 종류일 뿐 단계가 아니다 (`src/agent/evidence.ts:58`).
- 정책 문서는 `architecture`, `conventions`, `test-strategy`, `quality`이고 기본 위치는 `doc/*.md`다 (`src/agent/schemas.ts:19,50,132,185,242`). 지식 문서는 `data-dictionary`, `api-catalog`, `business-rules`, `features`, `flows`이고 기본 위치는 `doc/knowledge/*.md`다 (`src/agent/schemas.ts:20,298,323,348,381,402`). 위치는 매니페스트로 바꿀 수 있다 (`src/core/manifest.ts:138-161`).

**항목 형식과 상태**

- 항목은 ``### `KEY` 제목``, 필드는 `- 이름: 값`이고 `####`는 항목 경계가 아니다 (`src/agent/knowledge.ts:53,94,104`).
- 쓰는 필드는 `코드`, `테스트`, `범위`, `정책`, `흐름`, `기능`, `단계`, `별칭`, `구분`, `상태`다 (`src/agent/knowledgeIndex.ts:94-124`). `출처`는 `src/agent/schemas.ts:365-367`의 안내에 있다. `범위`의 `전체`와 `*`는 전역이다 (`src/agent/knowledgeIndex.ts:117`).
- `구분`은 `필수` 또는 `권장`, `상태`는 `확정` 또는 `관찰`이다. 관찰은 현재 코드의 동작이고 승인된 정책이 아니다 (`src/agent/schemas.ts:365-366`).
- 경험은 `doc/work/<ID>/experience.md`에 있고 (`src/agent/experience.ts:14`), `상태`의 `검증됨`은 `.code-agent/work/<work>/*.verify.json`과 이어질 때만 인정한다. 이 파일은 추적되는 Markdown 밖에 있다 (`src/agent/experience.ts:19,108-110`, `src/agent/layout.ts:14`).

**문맥 공급**

- 문서 검색의 확장 지점은 플러그인 자리 `context.docs`다 (`src/agent/plugins/protocol.ts:63,99,158`, `doc/design.md:176`). 어댑터는 stdin으로 JSON 하나를 받아 stdout으로 JSON 하나를 내고 제한은 20초, 1MiB다 (`src/agent/plugins/protocol.ts:58`, `doc/plugins.md:14,174`).
- 입력은 `{requirements:[{key,text}], docs:[{kind,path,headings:[{heading,line}]}], limit}`, 출력은 `{sections:[{path,heading,why}]}`다 (`doc/plugins.md:143`). 입력에 단계, 키워드, 출처를 담는 자리가 없다.
- 응답의 `protocol`, `version`, `requestId`, `ok`, `output` 중 하나라도 맞지 않으면 응답을 버리고 기본 구현으로 돌아간다 (`doc/plugins.md:96-97`). stdout 전체를 JSON 하나로 읽는다 (`src/agent/plugins/run.ts:232`).
- 플러그인이 채운 결과에도 줄 범위, 최신성, 반드시 적용할 정책은 code-agent 코드가 붙인다 (`src/agent/contextRender.ts:126-161`). 플러그인의 `heading`은 ``` `KEY` ```로 시작하면 항목, 아니면 절 제목으로 찾는다 (`src/agent/contextRender.ts:100-106`).
- 단계별 문맥은 `analysis`~`plan`이 `docSectionLines`를 쓰고 (`src/agent/contextRender.ts:244,350`, `doc/plugins.md:41`), `impact`는 `knowledgeVersion`이 있는 작업에서 `fileKnowledgeLines`를 함께 쓰고 (`src/agent/contextRender.ts:351-352`), `implement`, `review`, `deliver`는 파일 겹침 기반의 `fileKnowledgeLines`를 쓰고 (`src/agent/contextRender.ts:512,615,657`), `check`, `test`, `integrate`에는 문서 검색 결과가 없다 (`src/agent/contextRender.ts:525-569,620-628`).
- code-agent는 지식 색인을 저장하지 않고 요청 때 문서를 읽어 만든다 (`doc/design.md:170-176`). 벡터 검색을 두지 않으며 플러그인이 더 나은 검색을 끼울 자리라고 적혀 있다 (`doc/design.md:176`).

**master와의 경계**

- master 통신 프로토콜의 명령 목록에 지식 관련 필드가 없다 (`src/agent/master/protocol.ts:16-20`). `knowledge`는 `knowledge-prune` 동의 이름으로만 나온다 (`src/agent/master/protocol.ts:27,45`).
- 관리 실행의 기본 도구 허용 목록에서 셸은 `code-agent` 명령과 읽기 전용 git뿐이다 (`src/agent/master/protocol.ts:143-147`). 허용 도구는 페어링이 정하지 못하고 터미널에서만 정한다 (`src/agent/master/pairing.ts:30-31`).

## 이 저장소가 지키는 조건

위 사실에 맞추어 현재 구현이 지키는 조건이다.

- 원본 저장소에 쓰지 않는다. master-agent의 작업 트리 스냅샷이 미추적 파일까지 해시하기 때문이다.
- `project collect`를 부르지 않는다. revision이 올라가 임무가 `stale-context`가 되기 때문이다.
- 같은 입력과 세대면 stdout이 바이트까지 같다. 계획 context 해시 고정과 맞물린다.
- 수집 경로 차단 목록은 master-agent의 목록에 `.code-agent`를 더한 것이다 (`src/sources/path-policy.ts`).

## 제안 계약

아래는 제안이다. 이 저장소에 구현된 것은 CLI와 라이브러리이고 두 에이전트 쪽 코드는 없다. 각 항목을 구현하기 전에 해당 저장소의 소유자가 다시 판단해야 한다.

### 공통 호출 규칙

- 호출은 로컬 CLI 또는 라이브러리(`src/index.ts`)로 한다. 네트워크 서비스는 두지 않는다.
- CLI 결과는 stdout의 JSON 한 줄이고 오류도 stdout으로 나온다. master-agent의 CLI 관례(오류는 stderr)와 다르므로 호출자는 stdout과 종료 코드를 함께 읽는다. 종료 코드는 [retrieval.md](retrieval.md#종료-코드와-오류)에 있다.
- 결과의 항목 내용은 데이터이며 지시 권한이 없다(`notice`). 호출자는 이를 프롬프트에 넣을 때도 지시로 다루지 않는다.
- 결과는 근거다. master-agent의 증거 기록 자리에 넣지 않는다.
- 판단에는 `knowledge.confirmed`를 쓴다. `false`인 항목을 확정 근거로 쓰지 않는다.

### 식별자와 해시

두 저장소의 해시는 계산 방식이 달라 값을 서로 비교할 수 없는 것이 있다.

| 값 | 계산 | 비교 가능성 |
|---|---|---|
| master-agent `source.digest` | `sha256(canonical(base64(bytes)))`. `canonical`이 문자열을 JSON으로 감싸므로 따옴표까지 해시한다 | 아래 어떤 값과도 같지 않다 |
| master-agent `dependencyContracts[].sha256` | `sha256(bytes)` | `provenance.documentSha256`과 같은 방식이다 |
| agent-knowledge `provenance.documentSha256` | Git 블롭 바이트의 `sha256` | |
| agent-knowledge `provenance.itemSha256` | 항목 내용(UTF-8)의 `sha256`. 줄바꿈은 LF로 이어 붙인 값이다 | 파일 해시와 비교하지 않는다 |
| agent-knowledge `provenance.blobSha` | Git 블롭 ID | Git과 비교할 수 있다 |

- `documentSha256`에서 master-agent의 `digest`를 계산할 수 없다. 원본 바이트가 필요하다.
- 같은 문서라도 master-agent는 작업 트리 파일을, 이쪽은 커밋의 블롭을 읽는다. 줄바꿈 변환이나 미커밋 변경이 있으면 바이트가 다르다.
- 그래서 항목 ID를 master-agent의 소스 ID로 바꾸지 않는다. 두 식별 체계를 나란히 두고 `(프로젝트, 경로, 커밋)`으로 대응시킨다.
- 프로젝트 ID는 이쪽이 `/^[a-z0-9][a-z0-9._-]{0,63}$/`로 제한한다. master-agent의 ID가 이 형식에 맞지 않으면 연결 설정에 대응 표를 둔다. 경로 비교에 의존하지 않고 ID로 대응시킨다.

### 종류 대응표

| agent-knowledge 종류 | master-agent 종류 | code-agent 문서 종류 |
|---|---|---|
| `overview` | `overview` | 없음 |
| `responsibility` | `overview` | 없음 |
| `glossary` | `overview` | 없음 |
| `reference` | `overview` | 없음 |
| `architecture` | `overview` | `architecture` |
| `data-dictionary` | `overview` | `data-dictionary` |
| `feature` | `overview` | `features` |
| `flow` | `overview` | `flows` |
| `policy` | `policy` | 없음 |
| `convention` | `policy` | `conventions` |
| `test-strategy` | `policy` | `test-strategy` |
| `quality` | `policy` | `quality` |
| `business-rule` | `policy` | `business-rules` |
| `contract` | `contract` | 없음 |
| `dependency` | `contract` | 없음 |
| `api-catalog` | `contract` | `api-catalog` |
| `plan` | `plan` | 없음 |
| `experience` | `experience` | 없음 (`doc/work/<ID>/experience.md`) |
| `handoff` | `experience` | 없음 |

master-agent의 `code`에 대응하는 종류는 없다. 이 저장소는 소스 코드를 색인하지 않고 경로만 `codeLocations`와 `code`, `test` 연결로 돌려준다.

code-agent 문서를 색인할 때의 상태 대응은 다음과 같다.

| code-agent 표기 | agent-knowledge | 주의 |
|---|---|---|
| `상태: 확정` | `confirmed_policy` | 해석 가능한 근거가 있어야 유지된다. 없으면 `unverified`다 |
| `상태: 관찰` | `observed_behavior` | `코드`·`테스트` 경로나 근거가 커밋에서 해석되어야 유지된다 |
| `구분: 필수` | `mandatory` | `권장`은 필수가 아니다 |
| `상태: 가설` | `unverified` | |
| `상태: 검증됨` | `verified_experience` | `verify:<단계>`는 해석하지 않는다. 이 저장소가 `.verify.json`을 읽지 않으므로 다른 근거가 없으면 `unverified`다 |
| `상태: 폐기` | `deprecated` | |

### master-agent 연결

목표와 작업 범위로 검색해 계획·배정·재계획 입력에 근거를 제공한다.

- AI 호출 전 context를 만드는 단계에서 `search --profile master --project <임무 프로젝트>...`를 호출한다.
- 임무마다 `index.generation`을 기록하고 이후 호출에 `--generation`을 붙인다. 입력이 바이트까지 같아야 하기 때문이다. 재계획에서 새 세대를 쓰는 것은 master-agent가 판단한다.
- 프로젝트 간 자료는 `--allow-link`로 명시한다. 임무에 포함되지 않은 프로젝트를 넣지 않는다.
- 제안하는 전달 방식은 둘이다.
  - **파일 단위(현행 구조에서 가능)**: 결과의 경로로 `project collect` 목록을 만들어 임무 시작 전에 수집한다. 절 단위 정밀도를 잃고 32개, 256KiB 상한에 묶인다.
  - **항목 단위(master-agent 변경 필요)**: context에 소스와 별도로 `knowledge` 묶음을 추가하고 참조 검증이 항목 ID를 받게 한다. 권장안이다.

### code-agent로 넘길 근거

프롬프트 상한 20000자를 고려해 본문을 넣지 않고 식별자와 버전만 넘긴다.

```json
{"itemId": "sample-orders:docs/business-rules.md#BR-001", "generation": 1, "commit": "056f9d6f…", "itemSha256": "09d60bf5…"}
```

code-agent는 `get --id <itemId> --generation <세대> --profile code --project <프로젝트>`로 내용을 읽는다.

### code-agent 연결

담당 작업과 현재 단계에 맞춰 검색하고, 적용 전에 현재 코드와 대조할 출처를 제공한다.

- 독립 실행에서는 `search --profile code --project <담당 프로젝트> --phase <단계> --path <파일>...`을 쓴다. master-agent 없이 동작한다.
- 외부 계약은 `--allow-link <프로젝트>:contract`처럼 명시한다.
- `codeLocations`의 `path`, `commit`과 `provenance`의 `startLine`, `endLine`으로 원본을 대조한다. 색인은 커밋 기준이므로 적용 전에 현재 파일을 다시 읽어야 한다.
- 관리 실행에서 쓰려면 사람이 도구 허용 목록에 `agent-knowledge` 접두사를 추가해야 한다.

### `context.docs` 어댑터 제안

code-agent 코드를 바꾸지 않고 붙일 수 있는 지점이다. 별도 실행 파일로 만든다.

1. 봉투 `{protocol:"code-agent.plugin", version:"1", op, requestId, ...}`을 받아 `op`(`describe`, `probe`, `run`)을 처리한다.
2. `run`에서 `requirements[].text`를 합쳐 `--query`로 쓰고 `limit`을 넘긴다. 프로젝트는 입력에 없으므로 어댑터 설정으로 고정한다.
3. 결과 중 입력의 `docs` 경로에 있는 항목만 고른다.
4. `sections`로 변환한다. 키가 있는 항목은 `heading`을 ``` `KEY` 제목```으로, 절은 제목으로 쓴다. `why`에는 `selection.reasons`, `knowledge.status`, `commit`을 짧게 담는다.

제약은 다음과 같다.

- 입력에 단계가 없어 `--phase`를 쓸 수 없다. 이 자리는 `analysis`~`plan`에서만 불린다.
- 출력에 `path`, `heading`, `why`만 있어 항목 ID와 해시를 구조화해서 넘길 수 없다.
- `implement` 이후에는 불리지 않으므로 그 단계의 검색은 CLI 호출이 맡는다.

## 후속 작업

**이 저장소**

- [구현 범위](scope.md#구현-범위)의 `후속` 항목
- `context.docs` 어댑터 실행 파일
- 실제 프로젝트 자료를 쓰는 평가 묶음

**master-agent**

- AI 호출 전 검색 호출과 `index.generation` 기록
- 참조 검증이 항목 ID를 받도록 변경
- `task.references`에 항목 식별자와 버전을 싣는 인계 형식

**code-agent**

- `context.docs` 어댑터 등록과 입력에 단계·프로젝트를 담는 확장 검토
- 관리 실행 도구 허용 목록의 `agent-knowledge` 접두사
- `검증됨` 상태를 해석 가능한 근거로 노출하는 방법
