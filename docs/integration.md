# 에이전트 연동

이 문서는 agent-knowledge, code-agent, master-agent가 지식 근거를 주고받는 **공통 계약의 정본**이다. 다른 저장소는 자기 구현·설정 문서를 두고 이 문서를 링크한다. 계약을 바꾸려는 소비자는 자기 결과에 바꿀 내용을 적고, 이 문서는 한 세션만 고친다.

| 표시 | 뜻 |
|---|---|
| **구현됨** | 이 저장소의 CLI·라이브러리에 있고 자동 테스트가 있다 |
| **소비자 구현** | 적힌 커밋의 소비자 저장소에 있다 |
| **제안** | 이 문서가 정한 계약이다. 보내는 쪽과 받는 쪽이 모두 커밋하고 확인하기 전에는 지원한다고 표시하지 않는다 |
| **운영 판단** | 사람이 정할 정책이다. 이 문서는 기본값을 정하지 않는다 |

이 저장소의 테스트가 통과했다는 것은 생산자와 계약 자료가 맞는다는 뜻이다. 두 에이전트가 실제로 연결되었다는 뜻이 아니다. 연결은 소비자 저장소의 테스트와 세 저장소를 함께 돌리는 통합 검증으로 확인한다.

## 세 층

근거가 오가는 길에는 서로 다른 계약 세 개가 있다. 이름과 번호가 비슷해도 섞지 않는다.

| 층 | 무엇 | 소유 | 전송 |
|---|---|---|---|
| 생산자 API | `capabilities`, `status`, `search`, `get`, `verify`, `lease`, `index` | agent-knowledge | 로컬 CLI(stdin·stdout JSON) 또는 `src/index.ts` |
| 인계 전송 형식 | code-agent 제어 통신 `submit`의 `payload.knowledge`, `hello`의 `knowledge` 공지, 회복 명령 `knowledge` | 정의는 이 문서, 수신 파서는 code-agent | master → code-agent. 생산자는 끼지 않는다 |
| 소비자 내부 묶음 | master의 `context.knowledge` 봉인 묶음(`kb:<runId>`), 묶음 안 참조 `kitem:<프로젝트>:<16자 hex>`, `handoffBlock` | master-agent | 보내지 않는다. 계약이 아니다 |

- 생산자 응답 형식 `responseVersion`과 인계 형식 `knowledge.version`은 서로 다른 번호다. 둘 다 2가 있지만 같은 계약이 아니다.
- master의 `kitem:` 참조와 `kb:` 묶음 ID는 master 안에서만 뜻이 있다. 인계에는 생산자 `ref`에서 옮긴 필드만 싣는다([필드 대응](#필드-대응)).

## 현재 상태

소비자의 기준 커밋은 code-agent `3c5bbac`, master-agent `217f37f`다. 아래 표와 이 문서의 소비자 사실은 이 커밋 기준이고, 커밋되지 않은 소비자 변경은 지원으로 보지 않는다.

| 기능 | 생산자 | code-agent `3c5bbac` | master-agent `217f37f` |
|---|---|---|---|
| 형식 2 `search`·`get` | 구현됨 | 안 쓴다(형식 1) | 안 쓴다(형식 1) |
| `capabilities`, `verify` | 구현됨 | 안 쓴다 | 안 쓴다 |
| `lease` | 구현됨 | 해당 없음(임대를 갖지 않는다) | 안 쓴다 |
| 인계 형식 1 | 해당 없음 | 수신 구현 | 없다. `handoffBlock`은 형식 1이 아니고 보내지도 않는다(`not-sent`) |
| 인계 형식 2, hello 확장, 접수 범위 검사 | 해당 없음 | 제안 | 제안 |
| `required` 진행 게이트, 회복 명령 | 해당 없음 | 없다. 실패를 경고 문구로만 넣는다 | 해당 없음 |

**생산자 쪽에서 끝난 것**: 형식 2 검색(질의 여러 개, 문서 필터, 조각, 예산, 순위 방식 선택), `get` 형식 2(`expect`, `version.exact`), `verify`, `lease`, `index --lease-holder`, `capabilities`, `status` 형식 2, 재현 식별값. 소비자 연결에 필요한 값은 모두 이 응답에 있다.

**소비자에 연결되지 않은 것**: 위 표의 "안 쓴다", "없다", "제안" 전부. 목록은 [남은 일](#남은-일)에 있다.

## 정본 예제와 검증 자료

`docs/contract/`의 파일이 이 문서의 실행 가능한 예제다. 응답은 실제 CLI 출력에서 필요한 필드만 남겼고, `tests/contract-examples.test.ts`가 임시 Git 저장소와 임시 DB를 만들어 같은 요청을 다시 실행해 부분 집합으로 맞는지 본다. 빈 객체 `{}`는 생략이 아니라 빈 객체와만 맞는다. 자리표시(`<index-id>`, `<lease-id>`, `<handle>`, `<time>`, `<digest>`)의 규칙은 `tests/contract.ts`에 있다. fixture Git은 사용자·시스템 설정과 작성자 환경변수, 속성 파일의 영향을 받지 않게 실행하므로 커밋·블롭 SHA가 어느 기계에서나 같다. 자료는 합성 fixture(`evals/fixtures/ranking-workspace`)이고 실제 프로젝트 정책이 아니다.

| 파일 | 내용 |
|---|---|
| [contract/negotiation.json](contract/negotiation.json) | `capabilities`, `status` 형식 2, 두 소비자의 현재 형식 1 요청, 협의 없는 형식 2 필드와 지원하지 않는 형식의 거절 |
| [contract/code-profile.json](contract/code-profile.json) | code 프로필 형식 2 검색(질의 키, 문서 필터, `include.mandatory: false`, 단계·파일, 조각, 예산), 조각 ID로 `get`, 예산으로 빠진 항목 `get`, 항목·조각 참조 `verify` |
| [contract/master-profile.json](contract/master-profile.json) | 임대로 세대 고정, 프로젝트별 형식 2 검색(`allowedLinks`, 예산, `{generation, indexId, exact}`), 임대 갱신·목록·해제 |
| [contract/outcomes.json](contract/outcomes.json) | 결과 없음, 보충만, 예산 초과, 질의 상한(거절과 자르기), code 프로필 범위 오류 |
| [contract/reference-checks.json](contract/reference-checks.json) | 변조 해시·커밋·조각, 범위 밖, 다른 DB의 같은 세대 번호, 지워진 세대, `indexId` 없는 참조, 범위 확대 거절 |
| [contract/retention.json](contract/retention.json) | 임무 하나의 임대 둘, 옛 임대 해제, 만료, 같은 세대 재획득, GC 뒤 `lease-not-found`, 활성화하지 않은 세대의 GC와 게시 때 임대 |
| [contract/hash-normalization.json](contract/hash-normalization.json) | 줄바꿈·BOM이 다른 같은 글의 `itemSha256` |
| [contract/handoff-cases.json](contract/handoff-cases.json) | 인계 수신 사례(꼴·형식 → 접수 범위 → 생산자 확인)와 hello별 송신 결정. 송신 결정은 `refPool`의 글자 그대로의 생산자 `ref`로 낸다 |

`handoff-cases.json`은 소비자가 자기 파서와 송신 코드로 그대로 돌릴 수 있게 만든 자료다. 이 저장소의 `tests/handoff-contract.test.ts`는 `tests/handoff.ts`의 참조 구현과 실제 `verify`로 같은 사례를 확인한다. 참조 구현이 통과해도 소비자 구현이 같다는 증명은 아니다. code-agent의 계약 시험(`src/test/knowledgeHandoffContract.test.ts`)이 이 파일의 `schema`, `limits`, `cases[]`의 `id`·`receiverVersions`·`knowledge`·`expect`·`verification.refs[].cause`·`verification.progress`를 읽으므로 구조를 바꾸면 그 시험도 함께 확인한다.

## 생산자가 지키는 조건 (구현됨)

- 원본 저장소에 쓰지 않는다. 색인은 `git cat-file`로 커밋의 블롭을 읽고, 작업 트리 확인(`git status`)도 `--no-optional-locks`로 불러 `.git/index`를 고치지 않는다. master-agent의 작업 트리 스냅샷이 미추적 파일까지 해시하기 때문이다.
- 스스로 `confirmed_policy`, `verified_experience`를 붙이지 않는다. 근거가 해석되지 않으면 `unverified`다. `unverified`, `deprecated`, `conflicted`, `observed_behavior`는 어떤 형식에서도 `confirmed: true`가 아니다.
- 범위 밖 항목의 ID, 경로, 프로젝트를 어떤 응답에도 싣지 않는다. `budget.omitted`, `verify`의 `candidates`, BM25 통계도 범위 안에서만 만든다. 범위 밖 항목은 `get`·`verify`에서 없는 항목과 똑같이 보인다.
- 결과는 근거다. 승인·검증·테스트 통과·완료 기록이 아니다. `verify`는 참조 무결성 확인이고 임대는 세대 보호 표시다. 둘 다 작업 상태를 담지 않는다.
- 검색할 때마다 다시 색인하지 않는다. 색인은 별도 `index` 명령이고 실패하면 이전 활성 세대가 그대로다. GC도 `index`에서만 돈다.
- 에이전트의 작업 상태·승인·현재 단계를 저장하지 않는다. 임대 행에는 `{leaseId, generation, holder, acquiredAt, renewedAt, expiresAt}`만 있다.

## 호출 규칙 (구현됨)

- 호출은 로컬 CLI 또는 라이브러리(`src/index.ts`)로 한다. 네트워크 서비스는 두지 않는다.
- CLI는 명령마다 stdout에 JSON 문서 하나를 쓰고, 오류도 stdout의 `agent-knowledge.error`로 나온다. 호출자는 stdout과 종료 코드를 함께 읽는다. 진행 메시지는 stderr이고 `--quiet`로 끈다. 종료 코드와 `detail.reason`은 [retrieval.md](retrieval.md#종료-코드와-오류)에 있다.
- 설정과 DB 경로는 `--config`, `--retrieval-config`, `--db` 또는 환경변수 `AGENT_KNOWLEDGE_CONFIG`, `AGENT_KNOWLEDGE_RETRIEVAL_CONFIG`, `AGENT_KNOWLEDGE_DB`로 정한다. 소비자는 상속된 환경변수가 다른 DB를 가리키지 않도록 자식 프로세스에 경로를 명시하거나 이 변수들을 비운다. master `217f37f`는 비우고, code-agent `3c5bbac`는 그대로 넘긴다.
- 결과의 항목 내용은 데이터이며 지시 권한이 없다(`notice`). 프롬프트에 넣을 때도 지시로 다루지 않는다.
- 판단에는 `knowledge.confirmed`를 쓴다. `false`인 항목을 확정 근거로 쓰지 않는다.

**누가 CLI를 부르는가**

- code-agent는 호스트 프로세스가 `context.docs` 플러그인(어댑터)을 띄우고, 어댑터가 생산자 CLI를 부른다. 모델의 도구 호출이 아니므로 관리 실행의 도구 허용 목록에 아무것도 더할 필요가 없다.
- master는 자기 프로세스에서 AI 호출 전에 CLI를 부른다(`callKnowledge`). 계획 AI 호출에는 도구가 없다.
- 모델이 셸로 생산자 CLI를 직접 부르는 경로는 이 계약에 없다. 그 경로를 만들려고 넓은 허용 규칙을 더하지 않는다.

## 응답 형식과 기능 협의 (구현됨)

### 형식 1과 형식 2

- 요청에 `responseVersion`이 없거나 `1`이면 형식 1이다. 형식 1의 출력은 같은 색인에서 형식 2를 넣기 전과 바이트까지 같다(`tests/compat.test.ts`). 두 소비자가 지금 보내는 요청은 [contract/negotiation.json](contract/negotiation.json)의 `code-agent-v1-search`, `master-agent-v1-search`다.
- 형식 2는 `responseVersion: 2`(CLI는 `--response-version 2`)를 줄 때만 나온다.
- 형식 1 요청에 형식 2 필드가 있으면 조용히 무시하지 않고 `invalid-request`(`response-version-2-required`, `detail.fields`)로 거절한다. 지원하지 않는 형식은 `unsupported-response-version`(`detail.supported`)이다.
- 요청의 모르는 필드는 형식과 상관없이 `invalid-request`다. 응답에 필드를 **더하는** 것은 호환 변경이고 소비자는 모르는 응답 필드를 무시한다. 필드를 빼거나 뜻을 바꾸면 형식 번호를 올린다.
- 스키마 2 이전 DB에서도 형식 1은 그대로 읽는다. 형식 2 요청, `status --response-version 2`, `verify`, `lease`는 `index-missing`(`schema-upgrade-required`, 종료 코드 5)이다. 운영자가 `index`를 한 번 실행하면 마이그레이션된다([knowledge-model.md](knowledge-model.md#스키마와-마이그레이션)). 이 작업은 소비자가 하지 않는다.

### 협의 절차

1. `capabilities`를 부른다. DB와 원본 설정이 없어도 되지만 검색과 같은 `--retrieval-config`를 준다. `profiles.<프로필>.configHash`가 그 파일에서 나온다.
2. `commands.search.responseVersions`와 `commands.get.responseVersions`에 2가 있는지, 필요한 기능(`commands.verify`, `commands.lease`, `queryLimits`, `budget.fields`, `segments`, `verify.maxReferences`)이 있는지 본다. 질의 상한은 검색 설정마다 다르므로 `queryLimits.maxQueries`에서 읽는다.
3. `status --response-version 2`로 `indexId`, `databaseSchemaVersion`, `activeGeneration`을 읽는다.
4. `responseVersion: 2`로 요청하고 응답 `schemaVersion`이 2인지 확인한다.

### 이전 생산자를 만났을 때

협의 기능이 없는 빌드(`695de23`)와 스키마 1 DB의 응답이다.

| 관찰 | 뜻 |
|---|---|
| `capabilities` → `usage`, `알 수 없는 명령입니다: capabilities`, `detail.commands`에 `capabilities` 없음, 종료 코드 2 | 협의 이전 빌드 |
| 형식 2 요청 → `invalid-request`, `issues`에 `Unrecognized key: "responseVersion"`, 종료 코드 2 | 같은 빌드 |
| `--response-version` → `usage`(`Unknown option`), `verify` → `usage` | 같은 빌드 |
| 새 빌드 + 스키마 1 DB: `status` 형식 2, `get` 형식 2, `verify`, `lease list` → `index-missing`(`schema-upgrade-required`, `version: 1`, `required: 2`), 형식 1 검색은 성공 | DB가 마이그레이션되지 않았다 |

- **형식 1로 내려가도 되는 경우**: 근거 없이도 진행할 수 있는 선택 검색(shadow 비교, enabled 검색의 문맥 공급). 형식 2 필드를 빼고 형식 1 요청으로 다시 보내며, 결과와 기록에 형식 1임을 남긴다. 형식 1 결과에는 `indexId`, `configHash`, 조각, 예산이 없으므로 그 값으로 비교하지 않는다.
- **멈춰야 하는 경우**: 이미 작업에 고정된 `required` 참조를 확인해야 할 때, master가 `required` 참조를 인계하려고 형식 2 `ref`가 필요할 때. 요청에서 `version.indexId`, `version.exact`, `expect`를 빼고 형식 1로 다시 보내지 않는다. 그 필드가 신원 확인 자체이기 때문이다. 원인 갈래는 `adapter`(생산자 미지원)이고 생산자를 바꾼 뒤 다시 확인한다.
- 위 오류를 "참조가 틀렸다"로 읽지 않는다. 생산자가 할 수 없다는 뜻이다.

## 식별자와 해시 (구현됨)

### 항목 참조

형식 2의 `items[].ref`(검색)와 `item.ref`(`get`)가 생산자 참조다. 필드는 17개이고 항목 참조의 조각 필드 넷은 `null`이다.

| 필드 | 뜻 |
|---|---|
| `handle` | 인용용 짧은 이름 `ak-<20자 hex>`. 조회 키도 신원도 아니다 |
| `indexId` | DB를 만들 때 정한 무작위 32자 hex. 형식 2 응답에서는 `null`이 아니다 |
| `indexGeneration` | 이 참조를 만든 세대. 세대 번호는 DB마다 따로 센다 |
| `sourceId`, `projectId` | 원본과 프로젝트 |
| `commit` | 그 세대에서 원본의 커밋 SHA. 40자 또는 64자 hex |
| `itemId` | `<sourceId>:<경로>#<앵커>`. 규칙은 [knowledge-model.md](knowledge-model.md#항목-id) |
| `itemSha256` | 항목 내용의 SHA-256 |
| `documentSha256` | 문서 블롭 바이트의 SHA-256 |
| `blobSha` | Git 블롭 ID(40자 또는 64자 hex) |
| `path`, `startLine`, `endLine` | 지식 문서의 경로와 항목 줄 범위(1부터, 끝 포함) |
| `segmentId`, `segmentSha256`, `segmentStartLine`, `segmentEndLine` | 조각을 가리킬 때만 값이 있다. 조각 ID는 `<itemId>#<순번>` |

- `handle = "ak-" + sha256(canonicalJson({indexId, indexGeneration, itemId, segmentId, itemSha256, segmentSha256}))`의 앞 20자다. `canonicalJson`은 키를 정렬한 공백 없는 JSON이다. `verify`는 `handle`을 대조하지 않고 돌려줄 뿐이다. 다른 필드를 바꾸고 `handle`을 다시 계산하면 `handle`만으로는 변조를 알 수 없다([contract/handoff-cases.json](contract/handoff-cases.json)의 `v2-tampered-hash`).
- `indexId`는 DB 계보의 이름이다. DB 파일을 복사하거나 백업에서 되살리면 `indexId`와 세대 번호가 그대로 따라간다. 그래서 `indexId`와 세대가 같아도 내용 해시를 늘 함께 대조한다.
- 항목 ID 길이에는 생산자 상한이 없다. 제목이 길면 ID도 길다. 인계 수신 쪽은 512자를 넘는 `itemId`를 받지 않으므로 보내는 쪽이 거른다([송신 결정](#송신-결정-제안)).
- 형식 1의 `provenance`에도 `generation`, `commit`, `blobSha`, `documentSha256`, `itemSha256`, 줄 범위가 있지만 `indexId`는 없다. 같은 원본을 따로 색인한 DB는 세대 번호와 해시가 같을 수 있다([contract/reference-checks.json](contract/reference-checks.json)의 `verify-on-other-db`).

### 내용 해시 규칙

규칙의 정본은 [knowledge-model.md](knowledge-model.md#내용-해시)다. 받는 쪽이 작업 트리 파일로 `itemSha256`을 다시 계산할 때 그대로 따른다.

- UTF-8로 엄격하게 읽고 첫 BOM을 지운다.
- `\r\n`, `\n`, `\r`을 모두 줄 끝으로 본다. `\r?\n`으로만 나누면 맨 CR 파일에서 값이 달라진다.
- `startLine`~`endLine` 줄을 `\n`으로 잇고 끝 줄바꿈은 붙이지 않는다.
- `documentSha256`과 `blobSha`는 원본 바이트의 값이라 줄바꿈이 다르면 다르다. 작업 트리 대조에는 `itemSha256`(조각은 `segmentSha256`)만 쓴다.

[contract/hash-normalization.json](contract/hash-normalization.json)은 LF, CRLF, CR, BOM+CRLF, 끝 줄바꿈 없음, 섞인 줄바꿈의 같은 글이 모두 같은 `itemSha256`이 되는 것을 실제 색인으로 보인다.

### 위치 정보의 두 종류

- `ref`의 `path`, `startLine`, `endLine`은 **지식 문서**의 위치다. 근거 원문을 대조할 때 쓴다.
- `codeLocations[]`는 항목이 `코드`·`테스트`로 가리키는 **소스 코드 경로**다. 줄 범위가 없다.
- 형식 2의 `operations[]`는 HTTP 작업(`{method, path, field}`)이다. `path`는 URL 경로다.

## 재현 식별값 (구현됨)

같은 세대라도 검색 설정이나 빌드가 다르면 결과가 다르다. 형식 2 응답은 결과를 정하는 값을 모두 드러낸다.

| 값 | 위치 | 계산 |
|---|---|---|
| `indexId`, `generation` | `index` | 실제로 쓴 DB와 세대 |
| `scopeFingerprint` | `index` | 범위 안 원본의 `{sourceId, projectId, commit, configSha256}`, 연결 범위, 파서·분할·토큰화·해석 버전의 해시 |
| `configHash` | `retrieval` | 기본값을 채운 검색 설정 중 그 프로필이 쓰는 부분의 해시. 설정 파일 바이트의 해시가 아니다 |
| `ranker.version`, `queryVersion` | `retrieval` | 순위 방식과 질의 가공 규칙의 버전 |
| `digests.request` | `digests` | 정규화한 요청, 적용 범위, `indexId`, 실제 세대, `scopeFingerprint`, `configHash`, 버전들의 해시 |
| `digests.items` | `digests` | 남은 항목의 `ref`·묶음·순위와 예산으로 빠진 항목 목록의 해시 |
| `digests.result` | `digests` | 항목 전체·절·코드 위치·한계·`configHash`·버전의 해시 |

- `digests.request`가 같으면 `digests.result`도 같아야 한다. 다르면 생산자 결함이다.
- master의 `settingsHash`는 master가 정한 값(검색 설정 파일 해시, master 질의·선택 버전, 상한)이고 생산자 `configHash`와 다르다. 둘을 함께 기록한다.

### shadow 지문

캐시나 이전 비교를 다시 써도 되는지 판단할 지문은 기존 호출로 얻는다. 새 API는 없다.

| 얻는 값 | 호출 | 비용 |
|---|---|---|
| `index.indexId`, `index.generation`, `index.scopeFingerprint`, `retrieval.configHash`, `retrieval.ranker.version`, `retrieval.queryVersion`, `digests` | 형식 2 검색 응답 자체 | 추가 없음 |
| `profiles.<프로필>.configHash`, `versions`, `rankers[].version` | `capabilities` | 프로세스 하나, 검색 설정 파일 읽기. DB·Git을 읽지 않는다 |
| `indexId`, `activeGeneration`, `generations[].fingerprint`·`parserVersion`·`chunkerVersion` | `status --response-version 2` | DB 읽기 한 번. 원본 설정(`--config`·`AGENT_KNOWLEDGE_CONFIG`)이 있으면 색인된 원본마다 `git rev-parse` 한 번을 더 하고 `upToDate`를 채운다. 원본 설정 없이 `--db`만 주면 Git을 부르지 않고 `upToDate`는 `null`이다. 활성 세대가 없으면 `no-generation` |
| `indexId`와 임대 | `lease list` | DB 읽기 한 번. 읽기 전용 |

검색 전에 캐시를 쓸지 정하려면 `(indexId, activeGeneration, generations[]의 fingerprint, configHash, ranker 버전, queryVersion)`을 열쇠로 쓴다. `status`와 `capabilities` 두 번이면 얻는다. 지문만 필요하면 `status`에 원본 설정을 주지 않아 Git 호출을 없앤다. 둘 중 하나라도 실패하면 이전 성공을 지금 성공처럼 쓰지 않고 새로 비교한다.

## 세대 고정 (구현됨)

### 세대 선택

| 요청 | 고르는 세대 | 실패 |
|---|---|---|
| `version` 없음 | 활성 세대 | `no-generation` |
| `version.generation` | 그 세대. 없으면 활성 세대로 대신하지 않는다 | `generation-not-found` |
| `version.commits` | 원본마다 커밋이 접두사로 일치하는 **활성화된 적 있는** 가장 새 세대 | `commit-not-indexed` |
| `version.generation` + `commits` | 그 세대(활성화 여부와 상관없이)와 그 아래의 **활성화된 적 있는** 세대 중 커밋이 일치하는 가장 새 세대 | `commit-not-indexed` |
| 위 + `exact: true`(형식 2) | 그 세대만 | `commit-not-in-generation` |
| `version.indexId`(형식 2) | DB가 다르면 실패 | `index-id-mismatch` |

- 고정이 필요한 소비자는 형식 2로 `{generation, indexId, exact: true}`를 보낸다. 형식 1만 쓰는 소비자는 응답의 `index.generation`이 요청한 값과 같은지 직접 비교한다.
- 작업 브랜치 ref는 `index --ref <원본>=<리비전>`으로 정한다. 이 저장소는 프로젝트의 ref를 기본 브랜치로 바꾸지 않는다. 작업 브랜치를 기본 검색에 섞지 않으려면 `--no-activate`로 게시하고 번호로 고른다. 이런 세대는 보존 개수에 들지 않아 임대가 없으면 다음 `index`에서 지워진다. 참조로 넘길 세대면 `index --no-activate --response-version 2 --lease-holder <이름>`으로 게시와 임대를 한 트랜잭션에서 한다([contract/retention.json](contract/retention.json)의 `index-leased-work`).
- 세대에 기록되는 `requestedRef`·`refOrigin`은 그 세대를 처음 게시한 실행의 값이다. 커밋이 같아 `unchanged`로 다시 쓰면 `index` 출력의 원본별 값과 다를 수 있다. 근거를 정하는 것은 커밋 SHA다.
- 색인은 커밋 기준이다. 미커밋 변경은 색인에 없으며(`worktree-not-indexed`), 적용 전에 현재 파일을 다시 읽어 대조하는 것은 소비자 몫이다.

## 결과와 실패의 구분 (구현됨)

필드 정의는 [retrieval.md](retrieval.md#응답-형식-2-요청)에 있다. 예제는 [contract/outcomes.json](contract/outcomes.json)이다.

| 경우 | `status` | `retrieval.outcome` | 종료 코드 | 실패인가 |
|---|---|---|---|---|
| 질의와 일치한 자료가 있다 | `ok` | `matched` | 0 | 아니다 |
| 일치는 없고 필수·의존·연결 자료만 있다 | `ok` | `supplementary-only` | 0 | 아니다. 붙은 자료를 질의의 답으로 쓰지 않는다 |
| 아무것도 없다 | `no-results` | `no-results` | 3 | 아니다 |
| 예산으로 일부가 빠졌다 | `ok` | 그대로 | 0, `budget-truncated` | 아니다. `budget.omitted`로 `get`할 수 있다 |
| 예산으로 직접 일치가 모두 빠졌다 | `ok` | `matched` | 0, `direct-crowded-out` | 아니다 |
| 항목을 모두 빼도 응답이 `maxResponseBytes`를 넘는다 | `ok` | 그대로 | 0, `budget-exceeded`, `budget.exceeded: true` | 아니다. 응답이 상한보다 클 수 있다 |
| 질의가 `queryLimits.maxQueries`(기본 32, 검색 설정으로 1~256)를 넘었다 | 오류 | — | 2, `too-many-queries` | 요청 오류. `overflow: "truncate"`면 뒤쪽 질의를 버리고 `queries-truncated` |
| 범위가 프로필 규칙에 맞지 않는다 | 오류 | — | 4, `invalid-scope` | 요청 오류. 범위를 넓혀 다시 보내지 않는다 |

- `budget.maxExcerptChars`는 응답 전체 발췌 글자 수의 합이다. 필수 지정 항목도 예산으로 빠질 수 있으므로 `budget.omitted[].group`을 본다.
- `budget.maxResponseBytes`에는 최솟값이 있다([retrieval.md](retrieval.md#형식-2의-묶음과-출력-예산)). 남은 바이트가 그보다 적으면 상한을 낮춰 부를 수 없다. 더 부르지 않거나, 최솟값으로 불러 응답이 남은 예산보다 클 수 있음을 받아들인다.
- `include.mandatory: false`는 필수 지정 항목을 보충으로 붙이지 않을 뿐이다. 직접 일치한 항목은 `mandatory: true`여도 `direct`로 남는다.
- 생산자 상한(질의 수는 `capabilities.queryLimits.maxQueries`, `verify` 참조는 `verify.maxReferences`)과 소비자 상한(code-agent 질의 최대 8개·`get` 20번, master 프로젝트당 질의 8개·전체 60초)은 따로다. 소비자는 자기 상한 안에서 부르고 상한에 걸리면 진단에 남긴다.

**선택 검색의 대체와 고정 참조의 실패는 다르다.**

| 상황 | 선택 검색(근거 없이도 진행할 수 있다) | 이미 작업에 고정된 `required` 참조 |
|---|---|---|
| 생산자 없음·시간 초과·이전 빌드 | 기존 로컬 검색·수집으로 돌아간다 | 그 작업을 보류한다(`adapter`, `reverify`). 생산자가 돌아오면 같은 참조를 다시 확인한다 |
| 결과 없음·보충만·잘림 | 기존 경로로 진행한다 | 해당 없음 |
| 세대가 지워졌다 | 새 검색은 활성 세대로 해도 된다 | `expired`(`generation-expired`, `replan`). 활성 세대의 같은 항목으로 대신하지 않는다 |
| 해시·커밋·DB가 다르다 | 해당 없음 | `hash-mismatch`, `identity-mismatch`. 재계획 |
| `off`로 바꾸거나 플러그인을 뺐다 | 부르지 않는다 | 생산자를 몰래 부르지 않고 보류한다. `required`를 지우지 않는다 |

## code-agent 흐름

### 확인한 사실 (code-agent `3c5bbac`)

- `context.docs` 입력은 `{requirements, docs, limit}`에 선택 입력 `phase`(`analysis`·`impact`·`design`·`plan`), `files`, `refs`를 더한다. 어댑터가 `accepts`에 `context.docs.phase`, `context.docs.files`, `context.docs.refs`를 적어야 받는다.
- 출력 `sections[]`는 `{path, heading, why, ref}`이고 `ref`는 구조화된 `DocSectionRef`다(`engine: "agent-knowledge"`, `itemId`, `projectId`, `sourceId`, `generation`, `commit`, `blobSha`, `documentSha256`, `itemSha256`, `startLine`, `endLine`, `unit`, `kind`, `status`, `confirmed`, `declaredStatus`). 선택 필드 `pinned`, `fallback`, `diagnostics`가 있다.
- 어댑터는 형식 1 `search`·`get`·`status`만 부른다. 요청은 `{profile: "code", query, scope: {projects: [프로젝트]}, version?: {generation}, task?: {phase?, paths?}, limit}`이고 두 번째 질의부터 첫 응답의 세대로 고정한다. 문서 필터는 응답을 받은 뒤 어댑터가 거른다.
- 인계 참조는 형식 1 `get {id, profile, scope, version: {generation}}`으로 다시 읽어 세대·항목·커밋·`itemSha256`을 대조하고, 호스트가 작업 트리 파일과 다시 대조한다. 적힌 줄 범위의 해시가 다르면 제목 줄에서 시작하는 다른 범위 중 해시가 같은 곳이 정확히 하나일 때 옮긴 것(`moved`)으로 받는다. 문서 전체 항목은 옮겨 찾지 않는다. `required` 실패는 "근거 재확인 필요" 문구로만 들어가고 단계 이동을 막지 않는다.
- `submit`의 `knowledge`는 `start`에만 받고 `continue`에 실으면 `invalid-request`다. 참조를 받지 않는 설정(hello `refs.accepted`가 `false`)이면 `invalid-state`(`detail.reason: "knowledge-refs-not-accepted"`, `detail.mode`)다. 꼴 위반은 `invalid-request`이고 `detail.reason`이 없다.
- shadow 성공 캐시의 열쇠에 생산자 상태(`indexId`, 세대, `configHash`)가 없다.
- 해시를 다시 계산할 때 `\r?\n`으로 나눈다. `commit`, `blobSha`를 40자 hex로만 받는다.

### 형식 2 요청 (제안)

정본 예제는 [contract/code-profile.json](contract/code-profile.json)이다.

| `context.docs` 입력 | 형식 2 요청 |
|---|---|
| `requirements[].key`, `text` | `queries[]`의 `{key, text}`. 키는 `^[A-Za-z0-9_.:-]{1,64}$`이므로 맞지 않는 키는 바꾸고 대응을 기록한다 |
| `docs[].path` | `filters.documents`(프로젝트 안 경로) |
| `phase` | `task.phase` |
| `files` | `task.paths` |
| `limit` | `limit`, `budget.maxItems` |
| 플러그인 응답 상한 | `budget.maxResponseBytes` |
| 필수 정책을 호스트가 붙인다 | `include.mandatory: false` |
| 조각 단위 근거 | `segments: true`. 결과의 `segment`와 `ref.segment*` |
| 세대 고정 | 첫 응답의 `{generation, indexId}`를 `version`에 넣고 `exact: true` |

- 프로필은 `code`이고 프로젝트는 정확히 하나다. 연결은 `contract`·`dependency`·`api-catalog` 종류만 받는다. 범위 오류(`invalid-scope`)가 나면 범위를 넓혀 다시 보내지 않는다.
- 결과를 `sections[]`로 바꿀 때 `ref`에 생산자 `ref`의 값을 옮긴다. `DocSectionRef`에 `indexId`와 조각 필드를 더하는 것은 code-agent가 정한다.

## master-agent 흐름

### 확인한 사실 (master-agent `217f37f`)

- 검색은 형식 1 `search`뿐이다. 요청은 `{profile: "master", query, scope: {projects: [프로젝트], allowedLinks: [{project, kinds}]}, version?: {generation}, limit: 10}`이고 프로젝트마다, 질의마다 한 번씩 순서대로 부른다(프로젝트당 질의 8개, 전체 60초, 출력 2MiB). `allowedLinks`는 임무가 아니라 프로젝트 연결 기록(binding)에 있고 계획과 배정 사이에 바뀔 수 있다.
- 결과는 항목 단위로 `context.knowledge`에 들어간다. 묶음은 `kb:<runId>`로 봉인하고(`bundleHash`), 묶음 안 항목의 참조는 master가 만든 `kitem:<프로젝트>:<16자 hex>`다. 계획의 `task.knowledgeRefs`는 이 문자열 목록이고 `required` 구분이 없다.
- `settingsHash`는 검색 설정 파일 해시·master 질의 버전·선택 버전·상한·필수 정책의 해시다. `indexId`, `configHash`는 기록하지 않는다.
- `handoffBlock`은 `{schema: "master-agent.knowledge-handoff", version: 1, bundleId, bundleHash, generation, publishedAt, items}`를 만들고 40개·32KiB 상한을 계산만 한다. 인계 형식 1이 아니다. `dispatchEvidence`는 늘 `not-sent`이고 `submit` payload에 `knowledge`가 없다. hello의 `knowledge`를 읽지 않는다.
- 묶음은 `analysis-superseded`, `plan-replaced`, `mission-finished`에 해제한다. 임대는 없다.

### 형식 2 검색과 임대 (제안)

정본 예제는 [contract/master-profile.json](contract/master-profile.json)이다.

1. 분석 전에 임대를 얻는다: `lease acquire --holder master-agent:<missionId> --ttl <초> [--index-id <알고 있는 ID>]`. 응답의 `leaseId`, `indexId`, `lease.generation`, `expiresAt`을 그 분석의 묶음 기록에 저장한다([근거 보존과 인계 수명](#근거-보존과-인계-수명)).
2. 프로젝트마다 `{responseVersion: 2, profile: "master", queries, scope: {projects: [프로젝트], allowedLinks}, version: {generation, indexId, exact: true}, budget, limit}`로 부른다. 모든 호출이 같은 `(indexId, generation)`을 쓴다.
3. master의 전체 맥락 예산(항목 40개, 192KiB)은 master가 나눠 쓴다. 생산자 `budget`은 호출 하나의 상한이므로 남은 예산을 다음 호출의 `budget.maxItems`, `maxResponseBytes`로 넘긴다. 남은 바이트가 `maxResponseBytes`의 최솟값보다 적으면 더 부르지 않는다.
4. 묶음에 `items[].ref`를 그대로 보관한다. `kitem:` 참조는 master 안에서만 쓰고 인계 때 `ref`로 바꾼다.
5. 분석 기록에 `indexId`, `generation`, `scopeFingerprint`, `configHash`, `ranker.version`, `queryVersion`, `digests.request`, `digests.result`를 `settingsHash`와 함께 남긴다.

- `allowedLinks`는 분석 시점의 프로젝트 연결 기록에 있는 연결만 넣는다. 연결 프로젝트 항목은 계획의 문맥으로만 쓰고 인계하지 않는다([송신 결정](#송신-결정-제안)).

## 인계 형식

`submit`의 `payload.knowledge`다. `start`에만 싣는다. 아래 묶기 규칙은 제안이다.

- 처음 연 실행이 인계를 작업에 묶는다. 묶인 작업에 다른 인계로 `start`를 보내면 `conflict`(`detail.workId`, `refs`, `digest`)이고, 같은 인계를 다시 보내면 받고, `knowledge` 없이 보내면 묶인 인계를 이어 쓴다. 묶인 인계를 바꾸는 길은 [인계 교체](#회복-재검증과-인계-교체-제안)뿐이다.
- 접수 응답의 `knowledge`는 영수증 `{refs, version, digest, receipt: "stored", verification}`이다. `receipt`는 저장했다는 뜻이고 `verification`은 그 순간의 게이트 상태(`pending`, `verified`, `blocked`)다. 인계가 없는 실행의 응답에는 `knowledge` 키가 없다.

### `required`의 뜻

`required: true`는 "이 참조가 같은 내용으로 확인되기 전에는 **이 작업을** 진행하지 않는다"는 진행 의존 표시다.

- 지식의 상태(`confirmed`)와 다르다. 확정되지 않은 자료라도 작업이 그 내용에 기댄다면 `required`일 수 있다. `required`라고 확정 정책이 되지 않는다.
- 원본의 `구분: 필수`(검색 결과의 `mandatory`)와 다르다. `mandatory` 항목이 자동으로 `required`가 되지 않는다.
- 승인·테스트 통과·완료가 아니다. 확인된 참조는 "같은 근거"라는 뜻일 뿐이다.
- 누가 정하는가: master가 작업마다 정한다. 받는 쪽은 `required`를 낮추지 않는다. 보내는 쪽은 형식과 상관없이 `required`를 늘 적는다. 받는 쪽은 생략되면 `true`로 읽는다.

### 형식 1 (소비자 구현, code-agent `3c5bbac`)

```json
{"version":1,"refs":[{"itemId":"rank-auth:docs/auth-policies.md#AUTH-POL-001","generation":1,
  "commit":"b6921e51ae0c2cef081cb1bfbb46954269096b87",
  "itemSha256":"b0a0324ff7bc1261dadbcb464cf2d316bb34afd3f39be21a26c801ec6ece066b","required":true}]}
```

- 최상위 키는 `version`, `refs`뿐이고 `version`은 1이다.
- `refs`는 1~20개다. 참조 키는 `itemId`, `generation`, `commit`, `itemSha256`, `required`뿐이다.
- `itemId`는 1~512자, 제어 문자 없음, `:`와 `#`를 담는다. `generation`은 1 이상의 안전한 정수, `commit`은 40자 소문자 hex, `itemSha256`은 64자 소문자 hex, `required`는 선택 불리언(기본 `true`)이다. `itemId`가 겹치면 거절한다.
- 꼴 위반은 `invalid-request`다. `3c5bbac`는 `detail.reason`을 싣지 않는다. 받지 않는 설정과 `continue`의 거절은 [접수 거절](#접수-거절-제안)에 있다.
- `knowledge` 객체 전체의 정규 JSON 바이트 상한(hello `refs.maxBytes`, 없으면 32768, `knowledge-too-large`)은 형식 1에도 적용한다(제안). `3c5bbac`는 이 상한을 검사하지 않지만 보내는 쪽은 지킨다.
- master의 `handoffBlock` 꼴은 이 형식이 아니므로 거절된다(`v1-master-block`).
- 형식 1에는 `indexId`가 없다. 받는 쪽은 세대 번호와 해시로만 대조하므로 같은 원본을 따로 색인한 다른 DB를 가를 수 없다. 그래서 `required` 참조는 형식 2로만 보낸다([송신 결정](#송신-결정-제안)).

### 형식 2 (제안)

생산자 `ref`의 필드를 이름 그대로 싣고 `required`를 더한다. 감싸는 객체를 두지 않는다.

```json
{"version":2,"refs":[
 {"handle":"ak-69a35f3ff95562488d91","indexId":"17f75cc6617715a74285ff8903f05ce8","indexGeneration":1,
  "sourceId":"rank-auth","projectId":"rank-auth","commit":"b6921e51ae0c2cef081cb1bfbb46954269096b87",
  "itemId":"rank-auth:docs/auth-policies.md#AUTH-POL-001",
  "itemSha256":"b0a0324ff7bc1261dadbcb464cf2d316bb34afd3f39be21a26c801ec6ece066b",
  "documentSha256":"5ea0512d02b1f18f741c056a930472c0e14f59025a30667ad4ed50f5881aa31a",
  "blobSha":"03e76e5aeafca7a47c805163faf6df2857b1daa1","path":"docs/auth-policies.md","startLine":9,"endLine":15,
  "segmentId":null,"segmentSha256":null,"segmentStartLine":null,"segmentEndLine":null,"required":true},
 {"handle":"ak-fb296c4d8241080dbf7e","indexId":"17f75cc6617715a74285ff8903f05ce8","indexGeneration":1,
  "sourceId":"rank-auth","projectId":"rank-auth","commit":"b6921e51ae0c2cef081cb1bfbb46954269096b87",
  "itemId":"rank-auth:docs/token-guide.md#토큰-수명-주기",
  "itemSha256":"c67da925da20982450e95eaa5c8fdd3a716807d6b77d6b6b822b9a4329ff7adf",
  "documentSha256":"8de07d682ccc4559e0a7442a1ff126ad86d2e6c66fff0329472e10787361207a",
  "blobSha":"0bfab2d018b26273f1944ff0c182da9bb0f07d82","path":"docs/token-guide.md","startLine":9,"endLine":39,
  "segmentId":"rank-auth:docs/token-guide.md#토큰-수명-주기#2",
  "segmentSha256":"aa0f504b980f83aa7a46fb69ae901c11b782f01f6b226d6f5f01f308816db2c9","segmentStartLine":27,"segmentEndLine":39,
  "required":false}]}
```

**수신 검사** (꼴과 형식만 본다. 범위는 [접수 거절](#접수-거절-제안), 내용은 [수신 확인](#수신-확인과-실패-규칙)에서 본다)

- 최상위 키는 `version`, `refs`뿐이다. `version`은 수신자가 hello `refs.versions`로 공지한 값이어야 한다(아니면 `knowledge-version`).
- `refs`는 1~20개(`knowledge-limit`), `knowledge` 객체 전체의 정규 JSON이 32768바이트 이하다(`knowledge-too-large`).
- 필수 키 9개: `indexId`(32자 소문자 hex, `null` 불가), `indexGeneration`(1 이상 정수), `itemId`, `itemSha256`(64자 hex), `commit`(40자 또는 64자 hex), `sourceId`(`^[a-z0-9][a-z0-9._-]{0,63}$`), `path`(저장소 기준 상대 경로, 512자 이하, `\`·`..`·빈 조각 없음), `startLine`, `endLine`(1 이상, `startLine` ≤ `endLine`).
- `itemId`는 1~512자(UTF-16 코드 단위), 제어 문자 없음, 공백만으로 되지 않음, `:`와 `#`를 담고 `<sourceId>:<path>#`로 시작한다.
- 조각 필드 넷은 함께 있거나 함께 없다(`null`은 없음과 같다). `segmentId`는 `<itemId>#`로 시작하고 600자 이하, `segmentSha256`은 64자 hex, 조각 줄 범위는 항목 범위 안이다.
- 선택 키: `handle`(`^[A-Za-z0-9_.:-]{1,64}$`), `projectId`(`sourceId`와 같은 꼴), `documentSha256`(64자 hex), `blobSha`(40자 또는 64자 hex), `required`. 선택 키에는 `null`을 보내지 않는다. 그 밖의 키는 거절한다(`knowledge-format`). 발췌·상태·점수 같은 검색 결과 필드는 싣지 않는다.
- 겹침은 `(itemId, segmentId)`로 본다(`knowledge-duplicate`). 같은 항목의 다른 조각은 함께 보낼 수 있다.

**보내는 쪽 규칙**

- 생산자 `ref`에서 값이 있는 필드를 모두 보낸다. 받는 쪽이 요구하는 것은 9개지만 나머지도 대조에 쓴다.
- 한 인계의 참조는 모두 같은 `indexId`이고 같은 `indexGeneration`이다(임무에 고정한 세대).
- `handle`을 신원으로 쓰지 않는다. 신원은 `(indexId, indexGeneration, itemId, segmentId)`와 해시다.

**인계 해시**: `"sha256:" + sha256(canonicalJson({version, refs}))`이고 `refs`는 수신 검사로 정규화한 참조(`required`를 채우고 `null` 조각 필드를 뺀 것)를 `itemId`, `segmentId` 순으로 UTF-16 코드 단위 정렬한 것이다. 참조 순서가 달라도 같은 인계다. 위 형식 1 예시의 해시는 `sha256:9d58da9f206729535b5e01a8be7c64a64712a6821a52f9e9c1de2a2527782603`, 형식 2 예시의 해시는 `sha256:f3a6f95aa3e960338084cc3048c7e10b171f14c9ff6ef9c31c427f75ae96f083`이다([contract/handoff-cases.json](contract/handoff-cases.json)의 `v1-minimal`, `v2-golden-digest`).

### 접수 거절 (제안)

꼴이 맞아도 받는 쪽은 아래 순서로 보고 거절할 수 있다. 거절은 인계 전체이고 실행을 시작하지 않는다.

| 수신 응답 | 뜻 | 보내는 쪽 |
|---|---|---|
| `invalid-request`, `detail.reason`이 `knowledge-format`·`knowledge-limit`·`knowledge-too-large`·`knowledge-duplicate`, `detail.at` | 꼴 위반. 보내는 쪽 결함이다 | 같은 인계를 다시 보내지 않는다. 그 작업을 보류하고 결함으로 기록한다 |
| `invalid-state`, `detail.reason: "knowledge-refs-not-accepted"`, `detail.mode` | 그 사이 받는 쪽 설정이 바뀌어 참조를 받지 않는다(`3c5bbac`에도 있다) | hello를 다시 읽고 [송신 결정](#송신-결정-제안)을 처음부터 한다 |
| `invalid-request`, `detail.reason: "knowledge-version"` | 지금 공지하지 않은 형식이다 | 위와 같다 |
| `invalid-request`, `detail.reason: "knowledge-scope"`, `detail.refs[]: {itemId, segmentId?, reason}` | 참조 하나라도 받는 쪽 등록 문서 밖(`not-in-docs`)이거나 어댑터 설정이 대응시킨 프로젝트·원본 밖(`out-of-scope`)이다. 선택 참조도 같다 | 범위를 넓히지 않는다. 목록에 `required`가 있으면 그 작업을 보류한다(`knowledge-handoff-scope`). 선택 참조만이면 목록의 참조를 빼고 한 번 다시 보낸다 |
| `invalid-request`(`continue`에 `knowledge`) | `continue`는 작업에 묶인 인계를 쓴다 | `continue`에는 싣지 않는다 |
| `conflict`, `detail.workId`·`refs`·`digest` | 그 작업에 다른 인계가 묶여 있다 | 같은 인계로 보내거나 [인계 교체](#회복-재검증과-인계-교체-제안)를 쓴다 |

- 받는 쪽 등록 문서 목록은 hello에 없다. code-agent의 등록 문서는 [종류 대응표](#종류-대응표)의 code-agent 종류 중 인계를 받는 것이다. master는 자기 프로젝트 원본의 항목만 보내고, 그래도 `knowledge-scope`가 오면 위 규칙을 따른다.
- 접수(`submit` 성공, 영수증 `receipt: "stored"`)는 저장했다는 뜻이지 확인되었다는 뜻이 아니다. 받는 쪽 설정을 읽지 못하거나 원본·프로젝트 대응이 없으면 대응 검사(`out-of-scope`)는 하지 않고, 그 참조는 확인 단계에서 `adapter`로 막힌다.

### hello 공지 (제안)

`hello` 응답의 `knowledge`다. `schemaVersion`은 1 그대로다. 받는 쪽은 필드를 더할 수 있고 보내는 쪽은 모르는 필드를 무시한다. 아래는 참조를 받고 형식 2를 협의한 수신자의 공지다.

```json
{"schemaVersion":1,"mode":"enabled",
 "refs":{"supported":true,"accepted":true,"max":20,"versions":[1,2],"supportedVersions":[1,2],"maxBytes":32768,
         "requiredGate":true,"requiredDefault":true,"scope":"registered-docs"},
 "gate":{"resume":"knowledge-blocked","actions":["knowledge-reverify","knowledge-replan"],
         "causes":["unverified","hash-mismatch","identity-mismatch","expired","source-changed","source-deleted","scope","adapter"],
         "ttlSeconds":86400,"command":{"type":"knowledge","actions":["verify","replace"]}}}
```

| 필드 | 뜻 | 없을 때 |
|---|---|---|
| `mode`, `refs.supported`, `refs.accepted`, `refs.max` | `3c5bbac`에 있다. `accepted`는 `enabled`이고 플러그인이 `context.docs`로 등록되고 `accepts`에 `context.docs.refs`가 있을 때만 `true` | — |
| `refs.versions` | **지금 받는** 인계 형식. 보내는 쪽은 이것으로만 고른다. code-agent는 등록이 색인 식별 대조(`context.docs.refs.indexed`)를 협의했을 때만 2를 넣는다 | `[1]` |
| `refs.supportedVersions` | 그 빌드가 읽을 줄 아는 형식. 참고 값이고 보낼 형식을 정하지 않는다 | — |
| `refs.maxBytes` | `knowledge` 객체 정규 JSON의 바이트 상한 | 보내는 쪽이 32768을 쓴다 |
| `refs.requiredGate` | `required` 참조가 확인되기 전·실패하면 그 작업의 단계 이동·계획 실행·검증 실행·관리 실행 재개를 막고, 그 상태를 상태 조회의 `knowledge`와 `resume`으로 알린다 | `false` |
| `refs.requiredDefault` | 생략한 `required`를 `true`로 읽는다 | `true`(형식 1부터 같다) |
| `refs.scope` | 확인할 수 있는 범위. `registered-docs`는 자기 프로젝트의 등록 문서만이다. 다른 값은 정의하지 않았다 | `registered-docs`로 본다 |
| `gate.resume` | 게이트가 막을 때 상태 조회의 `resume.code` | — |
| `gate.actions`, `gate.causes` | 막을 때의 다음 동작과 원인 갈래 이름([판정과 원인 갈래](#판정과-원인-갈래)) | — |
| `gate.ttlSeconds` | 확인 기록을 인정하는 시간. 지나면 같은 참조를 다시 확인한다 | — |
| `gate.command` | 회복 명령([인계 교체](#회복-재검증과-인계-교체-제안)) | 회복 명령이 없다 |

- `3c5bbac`는 `requiredGate`가 없는 빌드다. `required`를 받아도 진행을 막지 않으므로 보내는 쪽은 `required` 참조를 보내지 않는다.
- 공지는 그 순간의 설정이다. 보내기 직전에 `hello`를 다시 읽는다.
- 지금 받는 형식은 `refs.versions` 하나로만 알린다.

### 필드 대응

| 생산자 `ref` | 인계 형식 1 | 인계 형식 2 | code-agent `DocSectionRef`(`3c5bbac`) | master 묶음 항목(`217f37f`) |
|---|---|---|---|---|
| `handle` | 없음 | `handle`(선택, 신원 아님) | 없음 | 없음 |
| `indexId` | 없음 | `indexId`(필수) | 없음 | 없음(기록하지 않음) |
| `indexGeneration` | `generation` | `indexGeneration` | `generation` | 묶음의 `generation` |
| `sourceId` | `itemId` 앞부분 | `sourceId`(필수) | `sourceId` | `sourceId` |
| `projectId` | 없음 | `projectId`(선택) | `projectId` | `producerProjectId` |
| `commit` | `commit`(40자만) | `commit`(40·64자) | `commit`(40자만) | `commit` |
| `itemId` | `itemId` | `itemId` | `itemId` | `itemId` |
| `itemSha256` | `itemSha256` | `itemSha256` | `itemSha256` | `itemSha256` |
| `documentSha256` | 없음 | 선택 | `documentSha256` | `documentSha256` |
| `blobSha` | 없음 | 선택 | `blobSha`(40자만) | `blobSha` |
| `path` | `itemId`의 `:`와 `#` 사이 | `path`(필수) | 절의 `path` | `path` |
| `startLine`, `endLine` | 없음 | 필수 | `startLine`, `endLine` | `startLine`, `endLine` |
| `segment*` 넷 | 없음. 조각은 부모 항목 참조가 된다 | 함께 선택 | 없음 | 없음 |
| — | `required` | `required` | 없음 | 없음(`task.knowledgeRefs`에 구분 없음) |

master의 `ref`(`kitem:…`)와 `bundleId`, `bundleHash`, `publishedAt`, 발췌, 상태는 인계에 싣지 않는다.

## 송신 결정 (제안)

master가 작업 하나를 배정할 때마다 정한다. 사례는 [contract/handoff-cases.json](contract/handoff-cases.json)의 `hello`다.

1. 참조가 없으면 `knowledge` 없이 보낸다.
2. 보내기 직전에 hello를 다시 읽는다. `knowledge`가 없거나 `refs.supported`가 `true`가 아니거나 `refs.max`가 없으면 `knowledge-handoff-unsupported`, `refs.accepted`가 `true`가 아니면 `knowledge-handoff-not-accepted`다.
3. 형식은 `refs.versions`(없으면 `[1]`)와 보내는 쪽이 만들 수 있는 형식의 교집합에서 고른다. 형식 1 생산자 묶음(`indexId` 없음)으로는 형식 2를 만들 수 없다.
4. `required` 참조가 하나라도 있으면 `refs.requiredGate`가 `true`이고 교집합에 2가 있을 때만 형식 2로 보낸다. 아니면 보류한다(`knowledge-handoff-ungated`, `knowledge-handoff-version`). 형식 1로 내려 보내지 않는다. 선택 참조만 있으면 교집합의 가장 높은 형식으로 보내고, 교집합이 없으면 뺀다.
5. 참조마다 본다.
   - 연결 프로젝트(`allowedLinks`) 항목은 받는 쪽이 확인할 수 없으므로 보내지 않는다. `required`면 보류(`knowledge-handoff-scope`), 선택이면 뺀다(`receiver-scope`).
   - 받는 쪽 [수신 검사](#형식-2-제안)가 거절할 참조(512자를 넘는 `itemId`, 형식 1의 64자 `commit` 등)는 보내지 않는다. `required`면 보류(`knowledge-handoff-unrepresentable`), 선택이면 문제 이름(`item-id-format`, `commit-format` 등)으로 뺀다.
   - 형식 1은 항목 단위다. 조각 참조는 부모 항목 참조(`itemSha256`)가 되고 같은 항목의 조각은 하나로 합친다. 하나라도 `required`면 `required`다. 형식 2는 `(itemId, segmentId)`마다 따로 보낸다.
6. `required` 참조만으로 `refs.max`나 `refs.maxBytes`(없으면 32768)를 넘으면 보류한다(`knowledge-handoff-limit`). 자르지 않는다. 그 안에 들면 `required`를 앞에 두고 선택 참조를 뒤에서부터 빼서(`receiver-limit`) 상한에 맞춘다.
7. 남은 참조가 없으면 `knowledge` 없이 보내고 뺀 목록을 기록한다(`no-sendable-refs`).
8. 받는 쪽 거절은 [접수 거절](#접수-거절-제안)대로 다룬다.

- 2·3·4에서 보낼 수 없을 때 `required`가 있으면 그 작업을 **보류**하고, 선택 참조만 있으면 **빼고** 기존 경로로 진행한다. 보류는 그 작업만이다. 다른 작업과 근거 없는 작업은 그대로 진행하고, 보류된 작업에 기대는 작업은 함께 기다린다.
- 보류한 작업은 배정을 시도할 때마다 hello를 다시 읽어 다시 정한다. 받는 쪽 사유(`unsupported`, `not-accepted`, `ungated`, `version`)는 받는 쪽 설정이나 빌드가 바뀌면 풀린다. 참조 쪽 사유(`scope`, `limit`, `unrepresentable`, 세대 소실)는 같은 참조로는 풀리지 않으므로 재분석과 계획 교체로 그 작업의 참조나 `required`를 바꾼다.

## 수신 확인과 실패 규칙

### 확인 절차 (제안)

1. 생산자 확인은 자기 범위로만 한다: `{profile: "code", scope: {projects: [자기 프로젝트]}}`이고 `allowedLinks`를 넣지 않는다. 두 방법 중 하나를 쓴다.
   - `verify` 한 번에 인계 참조를 그대로 넘긴다. `verify`는 `required` 같은 모르는 필드를 무시하고 한 번에 `verify.maxReferences`개까지 받는다. `reference.verdict`와 `mismatches`를 [판정 표](#판정과-원인-갈래)로 옮긴다. `current`는 참고 값이다. `other-index` 참조에도 `current`는 이 DB의 활성 세대로 계산된다.
   - 참조마다 `get` 형식 2. `id`는 조각 참조면 `segmentId`, 항목 참조면 `itemId`다. `version: {generation: <indexGeneration>, indexId, exact: true, commits: {<sourceId>: <commit>}}`, `expect: {itemSha256}`에 조각 참조면 `segmentSha256`을 더한다(항목 참조에 `segmentSha256`을 주면 비교할 조각이 없어 `hash-mismatch`다). `get`은 두 해시, `indexId`, 세대, 커밋만 대조한다. 돌아온 `item.ref`의 나머지 필드(`sourceId`, `projectId`, `path`, `startLine`, `endLine`, `blobSha`, `documentSha256`, 조각 줄 범위)를 받은 참조와 직접 비교하고, 비교하지 않은 필드가 있는 참조는 확인했다고 하지 않는다.
2. 작업 트리 대조: 생산자 확인을 지난 참조의 문서를 [내용 해시 규칙](#내용-해시-규칙)으로 다시 계산한다. 등록 문서 밖이면 읽지 않는다.
   - 조각 참조는 조각 범위를 그 해시로만 본다.
   - 항목 참조는 적힌 범위가 맞지 않으면 제목 줄에서 시작하는 다른 범위 중 해시가 같은 곳이 정확히 하나일 때 옮긴 것으로 받고 찾은 범위를 기록한다. 둘 이상이면 `ambiguous`, 없으면 `content-changed`다. 문서 전체 항목(`unit: document`)은 옮겨 찾지 않는다. 내용이 같은 글만 받으므로 근거는 바뀌지 않는다.
3. 결과를 인계의 정본 해시와 함께 기록한다. 기록은 hello `gate.ttlSeconds` 동안만 인정하고, 그 뒤와 인계가 바뀐 뒤에는 다시 확인한다. 진행 게이트는 생산자를 부르지 않고 기록만 읽으며, 기록한 범위가 지금 파일에서도 같은 해시인지 본다.

형식 1을 받은 쪽(`3c5bbac`)은 형식 1 `get`으로 세대를 지정해 읽고 해시·커밋을 대조한다. DB 신원은 확인할 수 없다.

### 판정과 원인 갈래

참조마다 사유(`reason`), 원인 갈래(`cause`), 회복(`recovery`)을 낸다. 사유가 가장 자세하고, 원인 갈래는 사람과 master에게 보이는 묶음이며, 회복은 다음 동작이다. 회복은 원인 갈래에서 끌어내지 않고 사유마다 정한다(`expired`에는 둘 다 있다). 받는 쪽은 모르는 사유를 `adapter`·`reverify`로 본다. 사유를 더할 때는 이 표와 받는 쪽을 함께 고친다.

| 결과 | 사유 | 원인 갈래 | 회복 |
|---|---|---|---|
| `verify` `intact`(또는 `get` 성공과 필드 비교 일치) + 작업 트리 해시 같음 | — | 확인됨 | — |
| `verify` `mismatch`에 `itemSha256`·`segmentSha256`, `get` `invalid-request`(`hash-mismatch`) | `hash-mismatch` | `hash-mismatch` | `replan` |
| `verify` `mismatch`에 `segmentId`(그 세대의 항목에 그 조각이 없다) | `not-found` | `scope` | `replan` |
| `verify` `mismatch`에 `commit`·`blobSha`·`documentSha256`, `get` `index-missing`(`commit-not-in-generation`), 돌아온 `ref`의 같은 필드가 다르다 | `commit-mismatch` | `identity-mismatch` | `replan` |
| `verify` `mismatch`에 `sourceId`·`projectId` | `out-of-scope` | `scope` | `replan` |
| `verify` `mismatch`에 `path`·`startLine`·`endLine`·조각 줄 범위만 | `range-mismatch` | `source-changed` | `replan` |
| `verify` `other-index`, `get` `index-missing`(`index-id-mismatch`) | `index-mismatch` | `identity-mismatch` | `replan` |
| `verify` `generation-missing`, `get` `index-missing`(`generation-not-found`) | `generation-expired` | `expired` | `replan` |
| `verify` `not-found`, `get` `not-found`(범위 밖도 같다) | `not-found` | `scope` | `replan` |
| `get` `invalid-scope` | `out-of-scope` | `scope` | `replan` |
| 등록 문서 밖 | `not-in-docs` | `scope` | `replan` |
| 작업 트리 범위의 해시가 다르다, 같은 해시가 둘 이상이다 | `content-changed`, `ambiguous` | `source-changed` | `replan` |
| 작업 트리 파일이 없다 | `missing-file` | `source-deleted` | `replan` |
| 확인한 범위가 그 뒤 바뀌었다, 지워졌다 | `source-changed`, `source-deleted` | `source-changed`, `source-deleted` | `replan` |
| 아직 확인하지 않았다, 인계가 바뀌었다, 기록을 읽지 못한다 | `not-verified`, `handoff-changed`, `record-unreadable` | `unverified` | `reverify` |
| 확인 기록의 인정 시간이 지났다 | `verification-expired` | `expired` | `reverify` |
| 생산자·어댑터를 쓸 수 없다(`off`, 미등록, 협의 실패, 생산자 오류·시간 초과, 형식 1로만 확인할 수 있는데 `indexId`·조각이 있는 참조) | `adapter-off`, `adapter-unregistered`, `adapter-unsupported`, `adapter-failed`, `not-returned`, `invalid-response`, `identity-unverifiable` | `adapter` | `reverify` |

- `verify` `mismatch`에 여러 필드가 있으면 표의 순서(해시, 조각, 원본 판, 원본·프로젝트, 범위)로 하나를 고른다. `mismatches`는 그대로 함께 기록한다.
- 참조가 적은 줄 범위와 생산자 항목의 범위가 다른 것은 code-agent를 따라 `source-changed`로 묶는다. 회복은 어느 쪽이든 재계획이다.
- 진행 게이트의 상태는 `none`(인계 없음), `pending`(`required`가 없는 인계가 아직 확인 전), `verified`, `blocked`(`required`가 확인 전이거나 실패)다. 확인된 참조에는 원인 갈래가 없고, 사례 파일에는 `cause: "verified"`로 적는다.
- `blocked`일 때 `action`은 막은 참조 중 회복이 `replan`인 것이 하나라도 있으면 `knowledge-replan`, 아니면 `knowledge-reverify`다. 상태 조회의 `resume.code`는 hello `gate.resume`이다.
- `required` 참조가 하나라도 확인되지 않았으면 그 작업은 진행하지 않는다. 선택 참조의 실패는 진단으로만 남긴다.
- `required`를 낮추거나, 활성 세대의 같은 ID로 바꾸거나, 범위를 넓혀 다시 찾지 않는다.

### 회복: 재검증과 인계 교체 (제안)

받는 쪽이 제어 명령 `knowledge`로 제공하고 hello `gate.command`로 알린다. 그 작업의 실행이 진행 중이면 `busy`다.

| 동작 | 요청 `payload` | 하는 일 | 응답 |
|---|---|---|---|
| `verify` | `{action: "verify", workId}` | 지금 작업에 묶인 같은 참조만 다시 확인한다. 새 검색은 없다. 지금 작업이 아니면 `invalid-state` | `{workId, knowledge, resume, stateVersion}`. 이벤트 `knowledge.verified` 또는 `knowledge.blocked` |
| `replace` | `{action: "replace", workId, reason, knowledge}`. `reason`은 필수(300자까지), `knowledge`는 새 인계 또는 `null`(인계를 뗀다) | `submit`과 같은 [접수 검사](#접수-거절-제안)를 한다. 정본 해시가 같으면 바꾸지 않는다(`replaced: false`). 다르면 묶인 인계를 바꾸고 이력 `{at, from, to, reason, controller, commandId}`(최근 20개)를 남기고 확인 기록을 지운다. 옛 인계 해시에 묶인 승인은 다시 받는다 | `{workId, replaced, knowledge, approval, resume, stateVersion}`. `knowledge`는 새 인계의 영수증이다. 이벤트 `knowledge.replaced` |

master의 순서는 다음이다.

- `knowledge-reverify`: 원인(어댑터 연결·설정, 생산자, 인정 시간)을 고친 뒤 `verify`를 보낸다. 같은 실패를 되풀이하지 않도록 한 번 보내고 다시 막히면 사람에게 넘긴다.
- `knowledge-replan`:
  1. 새 임대로 재분석해 새 묶음을 만든다.
  2. 그 작업의 참조와 `required`를 바꾸는 계획 교체를 한다. 시도 단위의 재시도가 아니다.
  3. 새 참조로 [송신 결정](#송신-결정-제안)을 한다.
  4. `knowledge replace`로 보낸다. 참조가 더 필요 없으면 `knowledge: null`이다.
  5. `replaced: true`이고 영수증의 정본 해시가 보낸 인계와 같으면 옛 임대를 푼다.
- 받는 쪽이 `gate.command.actions`에 `replace`를 알리지 않으면(`3c5bbac`) master는 묶인 인계를 바꿀 수 없다. 사람이 code-agent 작업을 끝내거나 중단(abort는 사람만 할 수 있다)한 뒤 새 작업을 연다.

### 경우별 규칙

| 경우 | 규칙 | 예제 |
|---|---|---|
| 범위 밖 참조 | 접수 단계에서 인계 전체가 `knowledge-scope`로 거절된다. 접수된 뒤 생산자 확인에서 범위 밖이면 없는 항목과 같은 `not-found`다. 어느 쪽도 범위를 넓혀 다시 확인하지 않는다. code 프로필에 프로젝트를 더하면 `invalid-scope`다 | `handoff-cases.json` `v2-out-of-scope`·`v2-not-in-docs`·`v2-missing-item`, `reference-checks.json` `verify-cases`의 `position` 4, `verify-widened-scope` |
| 다른 DB의 같은 세대 번호 | `indexId`가 다르면 세대 번호와 해시가 같아도 `other-index`다 | `verify-on-other-db`, `get-other-index`, `v2-other-index` |
| `indexId`가 `null`인 참조 | 스키마 2 DB에서는 언제나 `other-index`다. 형식 2 인계는 `null`을 받지 않는다. 형식 1 참조는 `verify`로 확인하지 않는다 | `verify-cases`의 `position` 7, `v2-null-index-id` |
| 다른 세대 | 고정한 세대로만 확인한다. 활성 세대가 달라도 참조 세대에서 `intact`면 확인됨이다. `current.state`가 `changed`면 재계획 후보로 알릴 뿐이다 | `retention.json` `verify-while-leased` |
| 해시 변조 | `mismatch`(`mismatches`에 바뀐 필드). `handle`은 대조하지 않는다 | `verify-cases`의 `position` 1·3, `get-hash-mismatch`, `v2-tampered-hash` |
| 세대 만료 | 임대가 만료되어도 GC 전에는 세대가 남아 있다. GC 뒤에는 `generation-missing`·`generation-not-found`이고 대신할 세대를 고르지 않는다 | `retention.json`, `v2-generation-gone` |
| 지원하지 않는 형식 | 생산자는 `unsupported-response-version`, 받는 쪽은 `knowledge-version`. 보내는 쪽은 공지된 형식만 쓴다 | `negotiation.json`, `v2-to-v1-receiver`, `unknown-version` |
| 허용된 외부 계약 | 인계하지 않는다. 받는 쪽은 자기 프로젝트 등록 문서만 확인한다(hello `refs.scope: "registered-docs"`, 확인 범위에 `allowedLinks` 없음). code 프로필 검색이 `contract`·`dependency`·`api-catalog` 연결을 받는 것은 문맥 공급이지 인계 확인 범위가 아니다. 연결 범위를 확인하는 수신자는 새 `refs.scope` 값과 함께 따로 협의한다(정의하지 않았다) | `outcomes.json` `code-profile-link-kind`, `link-required`, `receiver-gated` |

## 근거 보존과 인계 수명

생산자 세대는 GC로 지워진다. 보존 개수 `retainGenerations`(기본 5)는 활성화된 세대만 센다. `--no-activate`로 게시한 세대는 임대가 없으면 다음 `index`에서 지워진다([세대 고정](#세대-고정-구현됨)). 인계 참조가 가리키는 세대는 **master가 임대로 지킨다**. code-agent는 임대를 갖지 않고, 임대를 이유로 색인·삭제 권한을 받지 않는다. 정본 예제는 [contract/retention.json](contract/retention.json)이다.

보유자 이름은 임무마다 하나(`master-agent:<missionId>`)다. 갱신과 해제의 열쇠는 임무 상태에 묶음마다 저장한 `leaseId`이고, `lease list --holder`는 기록에 없는 고아 임대를 찾는 데만 쓴다.

| 사건 | master | code-agent |
|---|---|---|
| 분석 시작(`enabled`, 형식 2 생산자) | `lease acquire --holder master-agent:<missionId> --ttl <초> [--index-id <ID>]`. `{leaseId, indexId, generation, expiresAt}`을 그 분석의 묶음 기록에 저장한다 | — |
| 획득 실패 | `generation-not-found`·`index-id-mismatch`·`no-generation`이면 그 세대는 쓸 수 없다. 그 분석의 참조를 `required`로 보내지 않는다. `too-many-leases`·`store-unavailable`·시간 초과면 분석 결과는 문맥으로 쓰고, `required` 인계 전에 다시 얻는다. 끝내 못 얻으면 그 작업을 보류한다(`knowledge-lease-failed`) | — |
| 분석이 대체되었다, 실패했다, 묶음이 없다 | 그 분석의 임대를 푼다 | — |
| 검색 | `version: {generation, indexId, exact: true}` | — |
| `submit`(start) 직전 | `enabled`면 `lease renew --lease-id <ID> --ttl <초>`. `lease-expired`·`lease-not-found`면 같은 세대에 `--index-id`를 주어 다시 얻는다. `generation-not-found`면 `required`를 보류하고 재분석한다. 그 밖의 실패면 `required`를 보류한다. `off`·`shadow`면 생산자를 부르지 않으므로 갱신하지 않고 마지막 기록으로 정한다 | 인계를 [접수 검사](#접수-거절-제안)하고 작업에 묶는다 |
| 작업 진행 중 | 기간의 절반이 지나기 전에 `--ttl`을 주어 갱신한다. `--ttl`을 생략하면 86400초로 다시 잡힌다 | 진행 게이트 전에 참조를 확인한다 |
| master 재시작 | 임무 상태의 `leaseId`마다 갱신하고, 만료·소실이면 같은 세대에 다시 얻는다. `lease list --holder master-agent:<missionId>`(읽기 전용)에 있지만 기록에 없는 `leaseId`는 고아이므로 푼다 | 묶인 인계를 그대로 쓴다. `continue`는 같은 인계다 |
| 세대가 지워졌다 | 재획득이 `index-missing`(`generation-not-found`)이다. 그 세대를 참조하는 작업을 재계획 대상으로 표시한다 | 확인이 `expired`(`generation-expired`)로 막힌다 |
| 재계획(인계 교체) | 새 분석의 임대를 먼저 얻는다(같은 세대여도 새 임대). 옛 임대는 code-agent가 교체를 확인한 뒤(`replaced: true`, 정본 해시 일치), 또는 옛 작업이 끝나거나 사람이 중단한 뒤 푼다 | `knowledge replace`가 인계를 바꾸고 확인 기록을 지운다 |
| 임무 완료 | 그 세대를 참조하는 끝나지 않은 작업이 없을 때 `lease release`. 여러 번 불러도 된다 | — |
| 임무 취소 | 곧바로 푼다. 남은 code-agent 작업은 세대가 지워지면 `expired`로 막히고, 취소된 임무의 작업이므로 막히는 쪽이 안전하다 | — |

- 임대 해제는 master 묶음 해제(`analysis-superseded`, `plan-replaced`, `mission-finished`)와 별개다. 묶음을 놓아도 그 세대를 참조하는 code-agent 작업이 남아 있으면 임대를 풀지 않는다. 해제는 master가 잡은 자원 정리이므로 프로젝트 모드와 상관없이 한다.
- 임대는 `leaseId`마다 따로다. 보유자 이름이 같아도 한 임대를 풀면 그 임대만 풀린다. 옛 계획의 임대를 먼저 풀어도 새 계획이 자기 임대를 가지고 있으면 참조가 지워지지 않는다(`release-a` 뒤 `status-after-release`). 반대로 code-agent는 임대가 없으므로 master가 너무 일찍 풀면 막을 수 없다. 그래서 해제 조건은 master가 지킨다.
- 갱신 실패는 `not-found`, 종료 코드 3이다. 만료는 `lease-expired`(`detail.expiresAt`), 모르는 ID는 `lease-not-found`다. 만료된 임대 행은 다음 `index`의 GC가 지우므로(원본이 그대로인 `unchanged` 실행도 임대 행이 있으면 GC를 돈다) 그 뒤에는 `lease-not-found`이고 `lease list`에도 없다(`renew-after-gc`, `list-after-gc`). 그래서 저장한 `leaseId`에 대한 두 사유를 같게 다룬다. 만료된 임대는 되살리지 않고 같은 세대에 새로 얻는다. 활성 세대에 얻어 바꾸지 않는다.
- 임대가 만료되어도 GC는 `index`에서만 돌므로 그 사이 세대는 읽힌다(`verify-expired-before-gc`). 이 틈을 보존으로 기대지 않는다.
- master가 비정상 종료하고 돌아오지 않으면 임대는 기간이 지난 뒤 GC가 지운다.

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
| `test-strategy` | `policy` | `test-strategy`(인계를 받지 않는다) |
| `quality` | `policy` | `quality`(인계를 받지 않는다) |
| `business-rule` | `policy` | `business-rules` |
| `contract` | `contract` | 없음 |
| `dependency` | `contract` | 없음 |
| `api-catalog` | `contract` | `api-catalog` |
| `plan` | `plan` | 없음 |
| `experience` | `experience` | 없음 (`doc/work/<ID>/experience.md`) |
| `handoff` | `experience` | 없음 |

master-agent의 `code`에 대응하는 종류는 없다. 이 저장소는 소스 코드를 색인하지 않고 경로만 `codeLocations`와 `code`, `test` 연결로 돌려준다.

code-agent가 인계를 받는 등록 문서는 `architecture`, `conventions`, `data-dictionary`, `api-catalog`, `business-rules`, `features`, `flows` 종류로 등록한 문서의 절이다(`plugins/defaults.ts`의 `DOC_KINDS`). `test-strategy`, `quality` 문서와 등록하지 않은 문서의 참조는 접수 단계에서 `knowledge-scope`(`not-in-docs`)다.

### code-agent 상태 표기

| code-agent 표기 | agent-knowledge | 주의 |
|---|---|---|
| `- 상태: 확정` | `confirmed_policy` | 목록 항목의 정식 필드만 선언이다. 해석 가능한 근거가 있어야 유지되고 없으면 `unverified`다 |
| `상태: 확정`(목록 표시 없음), 표의 `상태` 행 | 비공식 표기 | `확정`은 선언이 되지 않는다. `폐기`·`가설`·`관찰`이면 그 절의 선언 상태가 된다. 규칙은 아래 링크에 있다 |
| `1. 상태: 확정`, `> 상태: 확정` | 선언 아님 | 번호 목록과 인용문 안의 표기는 기록과 진단만 하고 낮추는 데도 쓰지 않는다 |
| `- 상태: 관찰` | `observed_behavior` | `코드`·`테스트` 경로나 근거가 커밋에서 해석되어야 유지된다 |
| `- 구분: 필수` | `mandatory` | `권장`은 필수가 아니다. 인계의 `required`와 다르다 |
| `- 상태: 가설` | `unverified` | |
| `- 상태: 검증됨` | `verified_experience` | `verify:<단계>`는 해석하지 않는다. 이 저장소가 `.verify.json`을 읽지 않으므로 다른 근거가 없으면 `unverified`다 |
| `- 상태: 폐기` | `deprecated` | |

규칙은 [knowledge-model.md](knowledge-model.md#상태-선언의-표기)와 [비공식 표기](knowledge-model.md#비공식-표기)에 있다.

## 실행 모드

두 소비자 모두 `off`가 기본이고 `shadow`, `enabled`를 프로젝트마다 고른다(소비자 구현). 생산자 쪽 지침은 다음이다.

| 모드 | 생산자 호출 | 결과 사용 | 실패 시 |
|---|---|---|---|
| `off`(기본) | 부르지 않는다. 고정된 `required` 참조를 확인하려고 몰래 부르지도 않는다. master가 이미 가진 임대의 `lease release`만 예외다 | 없음 | `required`가 있는 작업은 진행하지 않는다. 보내는 쪽이 보류하거나, 보내면 받는 쪽 게이트가 `adapter-off`로 막는다 |
| `shadow` | 검색만. 읽기 전용이라 원본·DB에 남는 것이 없다. 임대를 새로 걸거나 갱신하지 않는다 | 비교 기록에만 남긴다. 모델 입력·계획 판단·승인 해시에 섞지 않는다 | 기록하고 무시한다 |
| `enabled` | 형식 2 검색·`get`·`verify`, master는 임대 | 켠 프로젝트에서만 근거로 더한다. 기존 필수 정책과 승인 절차는 그대로다 | 선택 검색은 기존 경로, 고정 참조는 [실패 규칙](#판정과-원인-갈래) |

- shadow 비교 기록에는 [shadow 지문](#shadow-지문)과 `items[].ref`를 남긴다.
- 순위 비교는 소비자의 기본 검색 결과를 [순위 목록](retrieval.md#순위-평가형식-2-묶음) 형식으로 내고 `eval --baseline`으로 같은 정답에 채점한다.

## 남은 일

**code-agent**

- 형식 2 확인, hello 확장, 접수 범위 검사, 진행 게이트, 회복 명령을 구현해 커밋한다. 그 전까지 이 문서의 해당 절은 제안이다.
- 인계 참조를 `get`으로 확인하면 돌아온 `ref`의 모든 필드(`blobSha`, `documentSha256`, `projectId` 포함)를 받은 참조와 비교하거나, `verify`로 확인한다([확인 절차](#확인-절차-제안)).
- `handoff-cases.json`의 수신 사례 전부(`submit`, `verification`의 `reason`·`recovery`·`gate` 포함)를 자기 시험으로 돌린다.
- shadow 캐시 열쇠에 [shadow 지문](#shadow-지문)을 넣는다.

**master-agent**

- 형식 2 검색, [송신 결정](#송신-결정-제안), 임대를 구현해 커밋하고 `handoff-cases.json`의 hello 사례를 자기 시험으로 돌린다.
- `knowledge-replan`일 때 [회복 순서](#회복-재검증과-인계-교체-제안)대로 계획 교체와 `knowledge replace`를 하고, 교체를 확인한 뒤 옛 임대를 푼다.
- 보류한 작업의 재평가 시점과 기대는 작업의 대기를 [송신 결정](#송신-결정-제안)대로 다룬다.
- 접수 결과와 code-agent의 확인 상태를 구분해 기록한다(접수 ≠ 확인).
- 세 저장소의 실제 CLI로 하는 통합 검증(정상, `required` 해시 불일치, 세대·DB 불일치, 만료, 원본 변경, 접수 범위 거절, 수신 불가, 재시작·재계획·완료·취소).

**운영 판단**

- 프로젝트별 `enabled` 전환. 사람이 확인한 정답으로 검색을 비교한 뒤 정한다.
- 기본 순위를 `bm25`로 바꿀지와 조각 단위 점수를 기본으로 켤지. 실제 문서 정답은 에이전트가 만든 잠정값이고 사람이 확인하지 않았다([retrieval.md](retrieval.md#bm25)).
- 프로필의 종류 가중치를 고칠지.
- 임대 기간과 `retainGenerations` 값.
- 작업마다 어떤 참조를 `required`로 둘지의 기준.
- 다른 프로젝트의 계약을 근거로 고정해야 할 때의 경로(그 계약을 소유한 프로젝트로 작업을 보낼지, 연결 범위를 확인하는 수신 형식을 새로 협의할지).
- 프로젝트 ID 대응 표의 위치와 소유자.
- 벡터 검색. 구성과 인터페이스만 있고 실제 의미 검색은 구현·검증하지 않았다.

## 후속 작업

- 이 저장소: [구현 범위](scope.md#구현-범위)의 `후속` 항목, 사람이 확인한 실제 문서 정답 묶음과 그것으로 잰 순위 비교.
- 소비자: 위 [남은 일](#남은-일).
