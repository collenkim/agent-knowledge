# 에이전트 연동

이 문서는 agent-knowledge가 code-agent와 master-agent에 내놓는 **생산자 계약의 정본**이다. 다른 저장소는 자기 구현·설정·호환성 문서를 두고 이 문서를 링크한다. 절마다 아래 표시 중 하나를 단다.

| 표시 | 뜻 |
|---|---|
| **구현됨** | 이 저장소의 CLI·라이브러리에 있고 자동 테스트가 있다 |
| **제안** | 계약 초안이다. 해당 저장소의 소유자가 판단한다 |
| **소비자 몫** | 소비자 저장소가 구현한다. 이 저장소는 구현하지 않는다 |

생산자 쪽 구현이 끝났다는 것은 두 에이전트가 실제로 연결되었다는 뜻이 아니다. 연결 여부와 동작은 각 소비자 저장소의 테스트와 통합 검증으로 확인한다.

## 확인한 사실

2026-11-09에 아래 커밋의 파일을 읽어 확인했다. 참조는 각 저장소 기준의 `경로:줄`이다.

| 저장소 | 읽은 커밋 |
|---|---|
| master-agent | `38a06d5c7fa8487719cc93140ad3252eb0d268b7` |
| code-agent | `182d49f48257d0c37bedb1907562b70f747e734c` |

2026-11-10에 두 저장소의 HEAD가 그대로임을 다시 확인했다. 두 작업 트리에는 이 저장소를 부르는 커밋되지 않은 소비자 코드가 있다. 아래 사실은 커밋된 파일 기준이고, 진행 중인 변경과의 대조는 [소비자 진행 상황](#소비자-진행-상황)에 따로 적는다.

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

## 생산자가 지키는 조건 (구현됨)

- 원본 저장소에 쓰지 않는다. 색인은 `git cat-file`로 커밋의 블롭을 읽고, 작업 트리 확인(`git status`)도 `--no-optional-locks`로 불러 `.git/index`를 고치지 않는다. master-agent의 작업 트리 스냅샷이 미추적 파일까지 해시하기 때문이다.
- `project collect`를 부르지 않는다. revision이 올라가 임무가 `stale-context`가 되기 때문이다.
- 스스로 `confirmed_policy`, `verified_experience`를 붙이지 않는다. 근거가 해석되지 않으면 `unverified`다. `unverified`, `deprecated`, `conflicted`, `observed_behavior`는 어떤 형식에서도 `confirmed: true`가 아니다.
- 범위 밖 항목의 ID, 경로, 프로젝트를 어떤 응답에도 싣지 않는다. `budget.omitted`, `verify`의 `candidates`, BM25 통계도 범위 안에서만 만든다.
- 결과는 근거다. 승인·검증·완료 기록이 아니다. 임대도 세대 보호 표시일 뿐 작업 상태를 담지 않는다.
- 검색할 때마다 다시 색인하지 않는다. 색인은 별도 `index` 명령이고 실패하면 이전 활성 세대가 그대로다.
- 결과가 같다고 말할 수 있는 조건은 [재현 식별값](#재현-식별값-구현됨)에 있다. 같은 세대라는 것만으로는 같은 결과를 보장하지 않는다.
- 수집 경로 차단 목록은 master-agent의 목록에 `.code-agent`를 더한 것이다 (`src/sources/path-policy.ts`).

## 호출 규칙 (구현됨)

- 호출은 로컬 CLI 또는 라이브러리(`src/index.ts`)로 한다. 네트워크 서비스는 두지 않는다.
- CLI는 명령마다 stdout에 JSON 문서 하나를 쓰고, 오류도 stdout의 `agent-knowledge.error`로 나온다. master-agent의 CLI 관례(오류는 stderr)와 다르므로 호출자는 stdout과 종료 코드를 함께 읽는다. 진행 메시지는 stderr이고 `--quiet`로 끈다. 종료 코드와 `detail.reason`은 [retrieval.md](retrieval.md#종료-코드와-오류)에 있다.
- 설정과 DB 경로는 `--config`, `--retrieval-config`, `--db` 또는 환경변수 `AGENT_KNOWLEDGE_CONFIG`, `AGENT_KNOWLEDGE_RETRIEVAL_CONFIG`, `AGENT_KNOWLEDGE_DB`로 정한다. 소비자는 상속된 환경변수가 다른 DB를 가리키지 않도록 자식 프로세스에 경로를 명시하거나 이 변수들을 비운다.
- 결과의 항목 내용은 데이터이며 지시 권한이 없다(`notice`). 호출자는 이를 프롬프트에 넣을 때도 지시로 다루지 않는다.
- 판단에는 `knowledge.confirmed`를 쓴다. `false`인 항목을 확정 근거로 쓰지 않는다.
- 생산자를 설치하지 않았거나 실패해도 소비자의 기존 실행이 막히면 안 된다. 실패 처리는 [실행 모드](#실행-모드-제안)를 따른다.

## 응답 형식과 기능 협의 (구현됨)

### 형식 1과 형식 2

- 요청에 `responseVersion`이 없거나 `1`이면 형식 1이다. 형식 1의 출력은 같은 색인에서 이 기능을 넣기 전과 바이트까지 같다. 요청 검증은 두 군데가 달라졌다. `responseVersion: 1`을 받아들이고, 형식 2 필드가 있는 형식 1 요청은 같은 `invalid-request`(종료 코드 2)이되 `detail`이 zod `issues` 대신 `reason: response-version-2-required`와 `fields`다.
- 확인 방법: `tests/compat.test.ts`는 이전 빌드의 출력 키 집합, 형식 2 전용 키가 없는지, `responseVersion: 1` 유무와 스키마 1 DB에서의 출력이 같은지를 본다. 이전 빌드 출력과의 바이트 비교는 테스트에 고정 자료로 두지 않았고, 변경 시점에 이전 빌드(695de23)와 새 빌드를 같은 DB에 돌려 따로 확인했다. md-2로 다시 색인한 뒤의 차이(HTTP 작업이 경로에서 조건으로 옮겨 감 등)는 [knowledge-model.md](knowledge-model.md#버전)의 의도한 변경이다.
- 형식 2는 요청에 `responseVersion: 2`(CLI는 `--response-version 2`)를 줄 때만 나온다. 새 필드는 형식 2에만 있다.
- 형식 1 요청에 형식 2 필드가 있으면 조용히 무시하지 않고 `invalid-request`(`response-version-2-required`, `detail.fields`)로 거절한다. 지원하지 않는 `responseVersion`은 `unsupported-response-version`이다. 소비자는 이 둘을 보고 형식 1로 내려갈 수 있다.
- 요청의 모르는 필드는 형식과 상관없이 `invalid-request`다(이전부터 그렇다).
- 같은 형식 안에서 응답에 필드를 **더하는** 것은 호환 변경이다. 소비자는 모르는 응답 필드를 무시한다. 필드를 빼거나 뜻을 바꾸면 형식 번호를 올린다.
- 스키마 2 이전 DB에서도 형식 1은 그대로 읽는다. 형식 2 요청, `verify`, `lease`는 `index-missing`(`schema-upgrade-required`)이다. `index`를 한 번 실행하면 DB가 마이그레이션된다([knowledge-model.md](knowledge-model.md#스키마와-마이그레이션)).

### 협의 절차

1. `agent-knowledge capabilities`를 부른다. DB와 원본 설정이 없어도 된다. 명령이 없으면(`usage`, 종료 코드 2) 이 기능 이전의 빌드이므로 형식 1만 쓴다.
2. `commands.<명령>.responseVersions`에 2가 있는지 본다. 쓸 기능은 `rankers`, `segments`, `queryLimits`, `budget.fields`, `leases`, `verify.maxReferences`로 확인한다.
3. `status --response-version 2`를 부른다. 스키마 2 이전 DB면 성공 응답 대신 `index-missing`(`reason: schema-upgrade-required`, `detail.version` < `detail.required`, 종료 코드 5)이 온다. 이때는 생산자를 못 쓰는 것이 아니므로 운영자가 `index`를 실행하기 전까지 형식 1을 쓴다. 성공하면 `databaseSchemaVersion`은 `index.v2RequiresSchemaVersion` 이상이다.
4. `responseVersion: 2`로 요청하고 응답의 `schemaVersion`이 2인지 확인한다.

```json
{"schema":"agent-knowledge.capabilities","schemaVersion":1,"ok":true,"status":"ok",
 "package":{"name":"agent-knowledge","version":"0.1.0"},
 "commands":{"search":{"responseVersions":[1,2],"defaultResponseVersion":1},"verify":{"responseVersions":[1],"defaultResponseVersion":1},"…":{}},
 "index":{"schemaVersion":2,"minReadableSchemaVersion":1,"v2RequiresSchemaVersion":2},
 "versions":{"parser":"md-2","chunker":"chunk-2","tokenizer":"tok-1","resolver":"resolve-1","query":"query-2"},
 "rankers":[{"name":"legacy","version":"keyword-legacy-1","default":true,"parameters":null},
            {"name":"bm25","version":"keyword-bm25-2","default":false,"parameters":{"k1":1.2,"b":0.75,"fieldWeights":{"key_aliases":4,"title":3,"headings":2,"body":1}}}],
 "segments":{"chunkerVersion":"chunk-2","maxChars":1500,"defaultEnabled":false},
 "queryLimits":{"maxQueries":32,"maxQueryChars":4000,"maxTermsPerQuery":48,"maxTotalTerms":256},
 "leases":{"ttlSeconds":{"default":86400,"min":60,"max":2592000},"maxLive":1024},
 "verify":{"maxReferences":256},
 "profiles":{"master":{"configHash":"2619…df2c"},"code":{"configHash":"ed8f…2184"}},
 "vector":{"implemented":false,"state":"not-implemented"}}
```

예시는 이 저장소의 합성 fixture(`evals/fixtures/ranking-workspace`)로 실제 실행한 출력을 줄였다. 해시는 앞뒤 네 자만 남겼다.

## 식별자와 해시 (구현됨)

### 항목 참조

형식 2의 항목마다 `ref`가 있다. 소비자 사이에 근거를 넘길 때 이 객체를 그대로 넘긴다.

| 필드 | 뜻 |
|---|---|
| `handle` | 인용용 짧은 이름 `ak-<20자 hex>`. 아래 필드에서 다시 계산할 수 있고 조회 키가 아니다 |
| `indexId` | DB를 만들 때 정한 무작위 32자 hex. DB를 바꿔 끼우면 달라진다. 스키마 2 이전 DB면 `null` |
| `indexGeneration` | 이 참조를 만든 세대. 세대 번호는 DB마다 따로 센다 |
| `sourceId`, `projectId` | 원본과 프로젝트 |
| `commit` | 그 세대에서 원본의 커밋 SHA. 저장소 형식에 따라 40자 또는 64자 hex다 |
| `itemId` | `<sourceId>:<경로>#<앵커>`. 앵커 규칙은 [knowledge-model.md](knowledge-model.md#항목-id) |
| `itemSha256` | 항목 내용의 SHA-256 |
| `documentSha256` | 문서 블롭 바이트의 SHA-256 |
| `blobSha` | Git 블롭 ID(40자 또는 64자 hex) |
| `path`, `startLine`, `endLine` | 원본 문서의 경로와 항목의 줄 범위(1부터, 끝 포함) |
| `segmentId`, `segmentSha256`, `segmentStartLine`, `segmentEndLine` | 결과가 조각을 가리킬 때만 값이 있다. 조각 ID는 `<itemId>#<순번>` |

- `handle = "ak-" + sha256(canonicalJson({indexId, indexGeneration, itemId, segmentId, itemSha256, segmentSha256}))[0..20]`이다. `canonicalJson`은 키를 정렬한 공백 없는 JSON이다.
- 해시 계산 규칙(UTF-8 엄격 해석, BOM 제거, `\r\n`·`\n`·`\r` 모두 줄 끝, 줄을 LF로 이음, 끝 줄바꿈 없음)은 [knowledge-model.md](knowledge-model.md#내용-해시)에 있다. 소비자가 현재 파일로 `itemSha256`을 다시 계산할 때 같은 규칙을 써야 한다. 맨 CR(`\r`)만 쓰는 파일에서 `\r?\n`으로 나누면 값이 달라진다.
- 형식 1에도 `provenance`에 `generation`, `commit`, `blobSha`, `documentSha256`, `itemSha256`, 줄 범위가 있다. 형식 1에는 `indexId`가 없으므로 DB가 바뀐 것을 알 수 없다.

### 위치 정보의 두 종류

- `provenance.path`, `startLine`, `endLine`(및 `ref`의 같은 필드)은 **지식 문서**의 위치다. 근거 원문을 대조할 때 쓴다.
- `codeLocations[]`는 항목이 `코드`·`테스트`로 가리키는 **소스 코드 경로**다. 줄 범위가 없고 `{sourceId, projectId, commit, path, relation, resolved, fromItemIds}`만 있다. 코드 줄 범위를 이 저장소가 알려 주지 않는다.
- 형식 2의 `operations[]`는 `범위`·`코드`·`테스트`에 적힌 HTTP 작업(`{method, path, field}`)이다. `path`는 URL 경로이지 파일 경로가 아니며 `codeLocations`에 들어가지 않는다.

### master-agent 해시와의 관계

| 값 | 계산 | 비교 가능성 |
|---|---|---|
| master-agent `source.digest` | `sha256(canonical(base64(bytes)))`. `canonical`이 문자열을 JSON으로 감싸므로 따옴표까지 해시한다 | 아래 어떤 값과도 같지 않다 |
| master-agent `dependencyContracts[].sha256` | `sha256(bytes)` | `documentSha256`과 같은 방식이다 |
| agent-knowledge `documentSha256` | Git 블롭 바이트의 `sha256` | |
| agent-knowledge `itemSha256` | 항목 내용의 `sha256` | 파일 해시와 비교하지 않는다 |
| agent-knowledge `blobSha` | Git 블롭 ID | Git과 비교할 수 있다 |

- `documentSha256`에서 master-agent의 `digest`를 계산할 수 없다. 원본 바이트가 필요하다.
- 같은 문서라도 master-agent는 작업 트리 파일을, 이쪽은 커밋의 블롭을 읽는다. 줄바꿈 변환이나 미커밋 변경이 있으면 바이트가 다르다.
- 그래서 항목 ID를 master-agent의 소스 ID로 바꾸지 않는다. 두 식별 체계를 나란히 두고 `(프로젝트, 경로, 커밋)`으로 대응시킨다.
- 프로젝트 ID는 이쪽이 `/^[a-z0-9][a-z0-9._-]{0,63}$/`로 제한한다. master-agent의 ID가 이 형식에 맞지 않으면 연결 설정에 대응 표를 둔다(**소비자 몫**). 경로 비교에 의존하지 않고 ID로 대응시킨다.

## 재현 식별값 (구현됨)

같은 세대라도 검색 설정(종류·상태 가중치, 프로필, 질의 상한)이나 패키지 버전이 다르면 결과가 다르다. 형식 2 응답은 결과를 정하는 값을 모두 드러낸다.

| 값 | 위치 | 계산 |
|---|---|---|
| `indexId`, `generation` | `index` | 실제로 쓴 DB와 세대 |
| `scopeFingerprint` | `index` | 범위 안 원본의 `{sourceId, projectId, commit, configSha256}`, 연결 범위, 파서·분할·토큰화·해석 버전의 해시. 범위 밖 원본이 바뀌어도 그대로다 |
| `configHash` | `retrieval` | 기본값을 채운 검색 설정 중 그 프로필이 쓰는 부분(`ranking`, `limits`, `profiles.<프로필>`)의 해시. 설정 파일 바이트의 해시가 아니므로 주석·순서만 바뀌면 같다 |
| `ranker.version`, `queryVersion` | `retrieval` | 순위 방식과 질의 가공 규칙의 버전 |
| `digests.request` | `digests` | 정규화한 요청(문서 필터는 원문 대신 `appliedScope.documents`), 적용 범위, 질의를 자르거나 합친 사실(`queries-truncated` 등의 기록), 원본 설정에는 있으나 그 세대에 없는 범위 안 원본, `indexId`, 실제 세대, `scopeFingerprint`, `configHash`, 버전들의 해시 |
| `digests.items` | `digests` | 남은 항목의 `ref`·묶음·순위와 예산으로 빠진 항목 목록의 해시 |
| `digests.result` | `digests` | 항목 전체·절·코드 위치·한계·`configHash`·버전의 해시 |

- `digests.request`가 같으면 같은 DB의 같은 세대에 같은 설정과 같은 빌드로 같은 요청을 보낸 것이다. 이때 `digests.result`가 같아야 한다. 다르면 생산자 결함이다.
- `digests.request`는 활성 세대로 골랐는지 번호로 골랐는지가 아니라 실제로 쓴 세대를 담는다. 같은 세대를 다른 방식으로 고른 두 요청은 같은 값이다.
- 시각(`index.publishedAt`)은 세대마다 고정이다. 지연 시간 같은 실행 환경 값은 응답에 없다.
- 결과 묶음을 고정하려는 소비자는 `digests.result`와 `items[].ref`를 함께 저장한다. 이 저장소는 결과 묶음을 따로 보관하지 않는다. 세대를 보존하려면 [임대](#세대-고정과-임대-구현됨)를 쓴다.

## 세대 고정과 임대 (구현됨)

### 세대 선택

| 요청 | 고르는 세대 | 실패 |
|---|---|---|
| `version` 없음 | 활성 세대 | `no-generation` |
| `version.generation` | 그 세대 | `generation-not-found`(활성 세대로 대신하지 않는다) |
| `version.commits` | 원본마다 커밋이 접두사로 일치하는 **활성화된 적 있는** 가장 새 세대 | `commit-not-indexed` |
| `version.generation` + `commits` | 그 세대 **이하**에서 커밋이 일치하는 가장 새 세대 | `commit-not-indexed` |
| 위 + `exact: true`(형식 2) | 그 세대만. 커밋이 다르면 내려가지 않는다 | `commit-not-in-generation` |
| `version.indexId`(형식 2) | DB가 다르면 실패 | `index-id-mismatch` |

- `generation` + `commits`는 이전부터 "지정한 세대 이하에서 일치 세대"를 고른다. 호환을 위해 그대로 두었다. 응답의 `index.generation`이 실제 세대이고, 형식 2는 `index.selection`(`by`, `exact`)으로 어떻게 골랐는지 알린다.
- 정확히 그 세대가 필요한 소비자는 형식 2로 `{generation, indexId, exact: true}`를 보낸다. 형식 1만 쓰는 소비자는 응답의 `index.generation`이 요청한 값과 같은지 직접 비교한다.
- 기준 ref와 작업별 ref는 `index --ref <원본>=<리비전>`으로 정한다. 실행할 때 커밋 SHA로 풀어 `index.sources[].commit`에 기록하고 요청 리비전은 `requestedRef`, 출처는 `refOrigin`(`config`|`override`)이다. 이 저장소는 프로젝트의 ref를 기본 브랜치로 바꾸지 않는다. 작업 브랜치를 기본 검색에 섞지 않으려면 `--no-activate`로 게시하고 번호로 고른다.
- 세대에 기록되는 `requestedRef`·`refOrigin`은 그 세대를 처음 게시한 실행의 값이다. 커밋이 같아 `unchanged`로 기존 세대를 다시 쓰면 세대의 기록은 바뀌지 않고, `index` 출력의 원본별 `requestedRef`·`refOrigin`은 이번 실행의 요청을 알린다. 세대가 무엇에서 만들어졌는지는 검색·`get` 형식 2의 `index.sources`를 본다. 내용을 정하는 것은 커밋 SHA이고 두 값이 달라도 근거는 같다.
- 색인은 커밋 기준이다. 미커밋 변경은 색인에 없으며(`worktree-not-indexed`), 적용 전에 현재 파일을 다시 읽어 `itemSha256` 규칙으로 대조하는 것은 소비자 몫이다.

### 세대 보존과 임대

GC는 `index`가 세대를 게시하거나 기존 세대를 다시 쓸 때 돈다. 검색·`get`·`verify`는 GC를 돌리지 않는다. 다음 세대는 지우지 않는다.

- 이번 실행이 게시하거나 다시 쓴 세대, 활성 세대
- 활성화된 세대 중 최근 `index.retainGenerations`개(기본 5)
- 유효한 임대가 걸린 세대

임대는 DB의 `generation_leases`에 `{leaseId, generation, holder, acquiredAt, renewedAt, expiresAt}`만 둔다. 작업 단계·승인·재시도 같은 실행 상태는 소비자 상태 저장소가 가진다.

| 소비자 사건 | 생산자 호출 |
|---|---|
| 임무·작업 시작 | `lease acquire --holder <소비자>:<작업 ID> [--generation <세대>] [--index-id <ID>]`. 응답의 `lease.generation`을 고정 세대로 쓴다. 새로 색인하면서 걸려면 `index --response-version 2 --lease-holder …` |
| 긴 작업 | 만료 전에 `lease renew --lease-id <ID>`. 만료된 임대는 되살리지 않는다(`lease-expired`) |
| 완료·취소 | `lease release --lease-id <ID>`. 여러 번 불러도 된다 |
| 비정상 종료 | 아무것도 하지 않아도 기간이 지나면 GC가 지운다. 재시작 때 `lease list --holder <이름>`으로 찾아 갱신하거나 푼다 |
| 재개 | 저장한 `ref`를 `verify`로 확인한다. `generation-missing`이면 그 세대가 지워진 것이다. `current.state`가 `moved`면 `movedBy`(`content`는 같은 내용, `key`는 같은 키지만 내용이 다를 수 있다)를 보고 받아들일지 정한다 |
| 재계획 | 새 세대를 쓸지는 소비자가 정한다. 새 세대에 임대를 걸고 옛 임대를 푼다 |

`verify`는 참조마다 그 세대에서 그대로인지(`reference.verdict`)와 현재 기준 세대에서 어떻게 되었는지(`current.state`)를 함께 돌려준다. 판정 값은 [retrieval.md](retrieval.md#verify)에 있다. 승인된 계획이 기댄 참조가 `intact`가 아니거나 `current.state`가 `same`이 아니면 그 작업을 재검토 대상으로 다룬다. 범위를 넓혀 다시 찾지 않는다.

## 검색 요청과 결과 (구현됨)

필드 정의는 [retrieval.md](retrieval.md#응답-형식-2-요청)에 있다. 아래는 소비자가 구분해야 하는 경우와 실제 예시다.

### 결과의 종류

| 경우 | `status` | 형식 2 `retrieval.outcome` | 종료 코드 |
|---|---|---|---|
| 질의와 일치한 자료가 있다(필수 묶음에 든 항목이 일치한 경우 포함) | `ok` | `matched` | 0 |
| 아무것도 일치하지 않았고 필수·의존·연결 자료만 있다 | `ok` | `supplementary-only` | 0 |
| 아무것도 없다 | `no-results` | `no-results` | 3 |
| 예산으로 일부가 빠졌다 | `ok` | 그대로 | 0, `budget-truncated` |
| 예산으로 직접 일치가 모두 빠졌다 | `ok` | `matched` | 0, `direct-crowded-out` |

형식 1에서는 필수 자료만 있는 경우를 `no-query-matches` 한계로 알아본다.

### 소비자별 권장 요청 (제안)

- **code-agent**: 필수 정책을 code-agent가 따로 붙이므로 `include.mandatory: false`로 중복을 뺀다. 플러그인 응답 상한 1MiB 아래로 `budget.maxResponseBytes`를 두고, 입력 문서로 `filters.documents`를 좁힌다.
- **master-agent**: 필수 자료를 유지한다(`include` 생략). 계획 입력 크기에 맞춰 `budget.maxItems`, `maxExcerptChars`를 둔다. 임무 동안 `{generation, indexId, exact: true}`로 고정한다.

### 예시

요청(code-agent 형식):

```json
{"responseVersion":2,"profile":"code",
 "queries":[{"key":"reset","text":"비밀번호 재설정 토큰 만료"},"토큰 수명 주기"],
 "scope":{"projects":["rank-auth"]},"task":{"phase":"implement"},
 "include":{"mandatory":false},"budget":{"maxItems":3,"maxResponseBytes":60000},"limit":5}
```

응답(줄임):

```json
{"schema":"agent-knowledge.search","schemaVersion":2,"ok":true,"status":"ok",
 "request":{"queries":[{"key":"reset","chars":14,"sha256":"f665…506f","duplicateOf":null},{"key":"q2","chars":8,"sha256":"a7d2…addc","duplicateOf":null}],
            "ranker":"legacy","segments":false,"include":{"mandatory":false,"dependencies":true,"links":true},"budget":{"maxItems":3,"maxResponseBytes":60000},"…":"…"},
 "index":{"indexId":"17f75cc6617715a74285ff8903f05ce8","generation":1,"activeGeneration":1,"activated":true,
          "selection":{"by":"active","exact":false},"scopeFingerprint":"a735…5200","parserVersion":"md-2","chunkerVersion":"chunk-2",
          "sources":[{"sourceId":"rank-auth","projectId":"rank-auth","commit":"b6921e51ae0c2cef081cb1bfbb46954269096b87","requestedRef":"HEAD","refOrigin":"config"}],"…":"…"},
 "retrieval":{"outcome":"matched","ranker":{"name":"legacy","version":"keyword-legacy-1"},"queryVersion":"query-2","configHash":"ed8f…2184",
              "counts":{"mandatory":0,"dependencies":0,"direct":5,"linked":0,"directMatched":8,"kept":{"mandatory":0,"dependencies":0,"direct":3,"linked":0}},
              "composition":{"direct":{"byProject":{"rank-auth":3},"byKind":{"api-catalog":1,"policy":1,"reference":1}},"supplementary":{"byProject":{},"byKind":{}}},"…":"…"},
 "items":[{"id":"rank-auth:docs/auth-policies.md#AUTH-POL-001","group":"direct","mandatory":false,"segment":null,
           "operations":[{"method":"PATCH","path":"/auth/password","field":"scope"}],
           "knowledge":{"status":"confirmed_policy","confirmed":true,"declaration":{"origin":"field","informal":[]},"…":"…"},
           "selection":{"rank":1,"directRank":1,"matchedQueries":["reset","q2"],"reasons":["keyword-match"],"…":"…"},
           "ref":{"handle":"ak-69a35f3ff95562488d91","indexId":"17f75cc6617715a74285ff8903f05ce8","indexGeneration":1,
                  "sourceId":"rank-auth","projectId":"rank-auth","commit":"b6921e51ae0c2cef081cb1bfbb46954269096b87",
                  "itemId":"rank-auth:docs/auth-policies.md#AUTH-POL-001","itemSha256":"b0a0…066b","documentSha256":"5ea0…a31a",
                  "blobSha":"03e76e5aeafca7a47c805163faf6df2857b1daa1","path":"docs/auth-policies.md","startLine":9,"endLine":15,
                  "segmentId":null,"segmentSha256":null,"segmentStartLine":null,"segmentEndLine":null},"…":"…"},"…"],
 "budget":{"truncated":true,"exceeded":false,"omittedCount":2,
           "omitted":[{"id":"rank-auth:docs/token-guide.md#토큰-오류-응답","segmentId":null,"group":"direct","directRank":4},
                      {"id":"rank-auth:docs/auth-policies.md#AUTH-POL-002","segmentId":null,"group":"direct","directRank":5}],"…":"…"},
 "digests":{"request":"eb83…2538","items":"24ab…88e3","result":"1ae2…90b7"},
 "limitations":[{"code":"budget-truncated","…":"…"},{"code":"keyword-only"},{"code":"unconfirmed-results"},{"code":"unresolved-links"},{"code":"worktree-not-indexed"}]}
```

`budget.omitted`의 ID는 범위 안이므로 `get`으로 이어 읽을 수 있다.

```json
{"responseVersion":2,"id":"rank-auth:docs/auth-policies.md#AUTH-POL-001","profile":"code","scope":{"projects":["rank-auth"]},
 "version":{"generation":1,"indexId":"17f75cc6617715a74285ff8903f05ce8","exact":true},
 "expect":{"itemSha256":"b0a0324ff7bc1261dadbcb464cf2d316bb34afd3f39be21a26c801ec6ece066b"}}
```

`verify` 요청은 `{profile, scope, references:[ref, …]}`이고 결과는 참조마다 하나다.

```json
{"schema":"agent-knowledge.verify","schemaVersion":1,"ok":true,"status":"ok","indexId":"17f75cc6617715a74285ff8903f05ce8",
 "against":{"indexGeneration":1,"activeGeneration":1},
 "results":[{"position":0,"handle":"ak-69a35f3ff95562488d91","itemId":"rank-auth:docs/auth-policies.md#AUTH-POL-001",
             "reference":{"verdict":"intact","mismatches":[],"knowledge":{"status":"confirmed_policy","confirmed":true}},
             "current":{"indexGeneration":1,"state":"same","itemSha256":"b0a0…066b","segment":{"state":"not-requested","segmentId":null,"segmentSha256":null},"candidates":[],"…":"…"}},
            {"position":1,"reference":{"verdict":"mismatch","mismatches":["itemSha256"],"…":"…"},"current":{"state":"changed","…":"…"},"…":"…"}],
 "summary":{"total":2,"intact":1,"problems":1,"current":{"same":1,"changed":1,"moved":0,"removed":0}}}
```

### 오류 예시

```json
{"schema":"agent-knowledge.error","schemaVersion":1,"ok":false,"status":"error","command":"search",
 "error":{"code":"invalid-request","message":"이 필드는 responseVersion 2 요청에서만 쓸 수 있습니다","detail":{"reason":"response-version-2-required","fields":["budget"]}}}
```

```json
{"schema":"agent-knowledge.error","schemaVersion":1,"ok":false,"status":"error","command":"search",
 "error":{"code":"index-missing","message":"지정한 세대에 요청한 커밋이 없습니다","detail":{"reason":"commit-not-in-generation","generation":1,"commits":{"rank-auth":"0000000"}}}}
```

첫째는 종료 코드 2(`invalid-request`), 둘째는 5(`index-missing`)다.

## 종류와 상태 대응

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

### code-agent 상태 표기

| code-agent 표기 | agent-knowledge | 주의 |
|---|---|---|
| `- 상태: 확정` | `confirmed_policy` | 목록 항목의 정식 필드만 선언이다. 해석 가능한 근거가 있어야 유지되고 없으면 `unverified`다 |
| `상태: 확정`(목록 표시 없음), 표의 `상태` 행 | 선언 아님 | 비공식 표기로 기록만 한다. 낮추는 값(`폐기`, `가설`, `관찰`)일 때만 적용하고 확정으로 올리지 않는다 |
| `1. 상태: 확정`, `> 상태: 확정` | 선언 아님 | 번호 목록과 인용문 안의 표기는 기록과 진단만 하고 낮추는 데도 쓰지 않는다 |
| `- 상태: 관찰` | `observed_behavior` | `코드`·`테스트` 경로나 근거가 커밋에서 해석되어야 유지된다 |
| `- 구분: 필수` | `mandatory` | `권장`은 필수가 아니다 |
| `- 상태: 가설` | `unverified` | |
| `- 상태: 검증됨` | `verified_experience` | `verify:<단계>`는 해석하지 않는다. 이 저장소가 `.verify.json`을 읽지 않으므로 다른 근거가 없으면 `unverified`다 |
| `- 상태: 폐기` | `deprecated` | |

형식 2의 `knowledge.declaration`은 선언이 어디서 왔는지(`origin`)와 기록한 비공식 표기(`informal[]`의 원문·문법·적용 여부)를 보여 준다. 규칙은 [knowledge-model.md](knowledge-model.md#상태-선언의-표기)에 있다.

## 실행 모드 (제안)

공통 요청문의 `off`, `shadow`, `enabled`에 대한 생산자 쪽 지침이다. 설정 키 이름과 위치는 각 소비자가 정하고 자기 문서에 적는다.

| 모드 | 생산자 호출 | 결과 사용 | 실패 시 |
|---|---|---|---|
| `off`(기본) | 부르지 않는다 | 없음 | 해당 없음 |
| `shadow` | 형식 2 검색을 부른다. 검색은 읽기 전용이라 원본·DB에 남는 것이 없다. 임대를 걸 필요는 없다 | 비교 기록에만 남긴다. 모델 입력·계획 판단에 섞지 않는다 | 기록하고 무시한다 |
| `enabled` | 형식 2 검색·`get`·`verify`, 필요하면 임대 | 켠 프로젝트에서만 근거로 추가한다. 기존 필수 정책과 승인 절차는 그대로다 | 기존 로컬 검색·수집으로 돌아간다. 이미 승인된 계획이 기댄 참조의 무결성 오류는 무시하지 않고 그 작업만 재검토한다 |

- 비교 기록에는 `digests`, `index.indexId`, `index.generation`, `retrieval.configHash`, `items[].ref`를 남기면 나중에 같은 결과인지 대조할 수 있다.
- 범위 오류·참조 불일치를 풀려고 `scope`를 자동으로 넓히지 않는다.
- 순위 비교는 소비자의 기본 검색 결과를 [순위 목록](retrieval.md#순위-평가형식-2-묶음) 형식으로 내고 `eval --baseline`으로 같은 정답에 채점한다.

## code-agent 연결

### `context.docs` 어댑터 (소비자 몫)

어댑터는 code-agent가 소유하고 구현한다. 이 저장소에는 어댑터를 두지 않는다. 같은 어댑터를 두 저장소에 만들지 않는다. 생산자 쪽에서 맞출 내용은 다음이다.

1. `run`의 `requirements[].text`를 형식 2 `queries`로 보낸다(요구 키를 `key`로). 질의 상한은 `capabilities.queryLimits`다.
2. 입력 `docs[].path`를 `filters.documents`로 보내 범위를 좁힌다. 범위 밖 문서가 응답에 오지 않는다.
3. `include.mandatory: false`로 code-agent가 직접 붙이는 필수 정책과 중복을 뺀다.
4. `limit`을 `limit`과 `budget.maxItems`로, 플러그인 응답 상한을 `budget.maxResponseBytes`로 넘긴다.
5. `sections[]`로 바꿀 때 키가 있는 항목은 ``` `KEY` 제목```, 절은 제목으로 쓴다. `why`에 `ref.handle`, `knowledge.status`, `commit`을 짧게 담는다. 구조화된 참조는 출력 형식에 자리가 없으므로 code-agent가 넓히기 전까지 어댑터 쪽 기록에 둔다.
6. 실패·빈 결과·`supplementary-only`는 기본 구현으로 돌아가는 사유로 쓴다.

입력에 단계가 없어 `task.phase`를 쓸 수 없다. 이 자리는 `analysis`~`plan`에서만 불리므로 `implement` 이후의 검색은 CLI 호출이 맡는다.

### 단계별 호출 (소비자 몫)

- 독립 실행에서는 `search --profile code --project <담당 프로젝트> --phase <단계> --path <파일>...`(또는 같은 내용의 형식 2 요청)을 쓴다. master-agent 없이 동작한다.
- 외부 계약은 `--allow-link <프로젝트>:contract`처럼 명시한다.
- 근거 원문은 `ref.path`, `startLine`, `endLine`(또는 `provenance`)으로 대조한다. 바뀐 코드 위치는 `codeLocations[].path`, `commit`으로 본다. 색인은 커밋 기준이므로 적용 전에 현재 파일을 다시 읽는다.
- 관리 실행에서 쓰려면 사람이 도구 허용 목록에 `agent-knowledge` 접두사를 추가해야 한다.

## master-agent 연결

### 계획 입력 (소비자 몫)

- AI 호출 전 context를 만드는 단계에서 `search --profile master`를 형식 2로 부른다. 프로젝트 간 자료는 `allowedLinks`로 명시하고 임무에 포함되지 않은 프로젝트를 넣지 않는다.
- 임무 시작 때 임대를 얻고 `{indexId, generation, exact: true}`로 고정한다. 분석 기록과 `contextHash` 입력에 `index.indexId`, `index.generation`, `retrieval.configHash`, `digests.request`, `digests.result`를 남긴다.
- 전달 방식은 둘이다.
  - **파일 단위(현행 구조에서 가능)**: 결과의 경로로 `project collect` 목록을 만들어 임무 시작 전에 수집한다. 절 단위 정밀도를 잃고 32개, 256KiB 상한에 묶인다.
  - **항목 단위(master-agent 변경 필요, 권장)**: context에 소스와 별도로 `knowledge` 묶음을 두고 참조 검증이 `ref`를 받게 한다.
- 결과를 master-agent의 증거 기록 자리에 넣지 않는다.

### code-agent 인계 (제안)

프롬프트 상한 20000자를 고려해 본문을 넣지 않고 `ref`만 넘긴다. 인계 묶음의 최소 형식은 다음이다.

```json
{"schema":"agent-knowledge.handoff","version":1,
 "refs":[{"indexId":"17f75cc6617715a74285ff8903f05ce8","indexGeneration":1,"itemId":"rank-auth:docs/auth-policies.md#AUTH-POL-001",
          "itemSha256":"b0a0324ff7bc1261dadbcb464cf2d316bb34afd3f39be21a26c801ec6ece066b","commit":"b6921e51ae0c2cef081cb1bfbb46954269096b87",
          "sourceId":"rank-auth","path":"docs/auth-policies.md","startLine":9,"endLine":15,"segmentId":null,"segmentSha256":null,"required":true}]}
```

- 필드 이름은 `ref`와 같게 둔다. `generation` 대신 `indexGeneration`, 그리고 `indexId`를 함께 넘긴다. 두 에이전트가 다른 DB를 읽을 수 있으므로 세대 번호만으로는 같은 근거임을 알 수 없다.
- `commit`, `blobSha`는 40자 또는 64자 hex를 받아야 한다.
- 받는 쪽은 `verify`로 참조를 확인하거나 `get`(형식 2, `expect.itemSha256`, `version.exact`)으로 읽는다. 맞지 않으면 그 참조를 거부하고 범위를 넓혀 다시 찾지 않는다.
- 묶음의 이름(`schema`)과 상한(개수·바이트)은 두 소비자가 함께 정한다. 이 저장소의 `verify`는 한 번에 256개까지 받는다.

## 소비자 진행 상황

2026-11-10에 두 저장소의 커밋되지 않은 소비자 코드를 읽기 전용으로 대조했다. 진행 중인 변경이라 줄 번호는 바뀔 수 있고, 어느 쪽도 이 계약의 구현을 마쳤다는 뜻이 아니다.

- 두 소비자 모두 형식 1 CLI만 쓴다. 읽는 필드는 모두 형식 1에 같은 이름·형식으로 있어 이번 변경으로 깨지지 않는다.
- 두 소비자 모두 `off`가 기본이고 `shadow`는 비교 기록만 남기며 실패를 삼키고, `enabled`는 실패하면 기존 경로로 돌아간다. 결과를 승인·증거로 쓰지 않는다.
- 맞춰야 할 점:
  - code-agent가 내용 해시를 다시 계산할 때 `\r?\n`으로 줄을 나눈다. 맨 CR 파일에서 [내용 해시](knowledge-model.md#내용-해시) 규칙과 달라진다.
  - code-agent가 `commit`, `blobSha`를 40자 hex로만 받는다. SHA-256 저장소에서는 64자다.
  - code-agent의 참조 필드는 `generation`을 쓰고 `indexId`가 없다. 두 소비자의 인계 형식도 서로 다르다. [code-agent 인계](#code-agent-인계-제안)의 최소 형식으로 맞춘다.
  - code-agent가 생산자 환경변수(`AGENT_KNOWLEDGE_*`)를 자식 프로세스에 그대로 넘긴다.
  - 두 소비자의 문서에 "설정 해시·DB 식별자·조각 분할이 없다"는 설명이 남아 있다. 형식 2에는 있다.
- 다시 색인하면 `parserVersion`이 `md-2`, `chunkerVersion`이 `chunk-2`가 된다. 소비자의 테스트 대역(fake CLI)은 `md-1`, `chunk-1`을 낸다.

## 남은 판단

이 저장소에서 정하지 않은 운영 정책이다.

- 기본 순위를 `bm25`로 바꿀지와 조각 단위 점수를 기본으로 켤지. 합성 자료와 실제 문서로 쟀지만([retrieval.md](retrieval.md#bm25)) 실제 문서의 정답은 에이전트가 만든 잠정값이고 사람이 확인하지 않았다.
- 프로필의 종류 가중치를 고칠지. 실제 문서 비교에서 종류 가중치를 모두 1로 둔 변형(`flatKindWeights`)이 master 프로필의 직접 결과와 필수 포함률을 크게 올렸고 code 프로필에서는 차이가 작았다. 같은 잠정 정답으로 잰 값이라 기본값은 바꾸지 않았다.
- 소비자별 임대 기간과 보유자 이름 규칙, `retainGenerations` 값.
- 프로젝트 ID 대응 표의 위치와 소유자.
- 인계 묶음의 이름·상한과 `required`의 의미.
- `검증됨` 상태를 해석 가능한 근거로 노출하는 방법.
- 벡터 검색. 구성과 인터페이스만 있고 실제 의미 검색은 구현·검증하지 않았다.

## 후속 작업

**이 저장소**

- [구현 범위](scope.md#구현-범위)의 `후속` 항목
- 사람이 확인한 실제 문서 정답 묶음과 그것으로 잰 순위 비교

**master-agent**

- 형식 2 협의, 임무 단위 임대와 `{indexId, generation, exact}` 고정
- 참조 검증이 `ref`를 받도록 변경
- [code-agent 인계](#code-agent-인계-제안) 최소 형식으로 `task.references` 전달

**code-agent**

- `context.docs` 어댑터를 형식 2(`queries`, `filters.documents`, `include.mandatory: false`, `budget`)로 전환
- 내용 해시 줄 나눔 규칙, 64자 SHA, `indexId`·`indexGeneration` 참조 필드
- 관리 실행 도구 허용 목록의 `agent-knowledge` 접두사
- `검증됨` 상태를 해석 가능한 근거로 노출하는 방법
