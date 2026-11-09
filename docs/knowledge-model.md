# 지식 모델

원본 자료가 색인을 거쳐 어떤 항목이 되는지, 항목의 상태와 출처를 어떻게 정하는지 적는다.

## 원본

원본은 `config/sources.yaml`에 등록한 로컬 Git 저장소다. 예시는 [config/sources.example.yaml](../config/sources.example.yaml)에 있다.

| 필드 | 뜻 |
|---|---|
| `id` | 원본 ID. `/^[a-z0-9][a-z0-9._-]{0,63}$/`, 중복 불가 |
| `project` | 프로젝트 ID. 형식은 `id`와 같고 여러 원본이 공유할 수 있다 |
| `path` | Git 최상위 경로. 절대 경로 또는 설정 파일 기준 상대 경로 |
| `ref` | 색인할 리비전. 기본값 `HEAD` |
| `include`, `exclude` | 저장소 기준 glob(`**`, `*`, `?`), 대소문자 구분 |
| `defaultKind` | 종류를 정하지 못한 문서의 종류. 기본값 `reference` |
| `rules` | 경로별 규칙. 먼저 일치한 하나만 적용한다 |

규칙에는 `match`, `kind`, `status`, `basis`, `mandatory`를 쓴다. `status`가 `confirmed_policy`나 `verified_experience`이면 `basis`가 필수이고, 없으면 설정 검사에서 `config-invalid`가 된다. 규칙의 `status`와 `basis`는 특정 문서에 대해 운영자가 의도적으로 쓰는 선언이다. 쓰면 그 문서의 항목이 원본 근거를 해석하지 않고 확정되므로 예시 설정에는 주석으로만 둔다.

`sources`는 비어 있을 수 없다. `path`는 Git 최상위여야 하고 `index`와 `validate`가 같은 검사(`src/sources/git.ts`의 `assertGitToplevel`)를 쓴다. 하위 디렉터리와 bare 저장소는 `not-git-toplevel`이며 `index`는 `source-unavailable`로 중단하고 활성 세대를 유지한다.

색인에 들어가는 것은 선택한 커밋에서 Git이 추적하는 일반 파일이면서 `.md` 또는 `.markdown`인 문서뿐이다. 심볼릭 링크와 서브모듈은 읽지 않고 근거나 코드 연결로도 해석하지 않는다. 커밋하지 않은 변경은 색인하지 않으며 `validate`가 `dirty-tracked-documents` 경고를 낸다.

| 건너뛴 이유 | 조건 |
|---|---|
| `blocked-path` | 경로 조각이나 확장자가 [차단 목록](../src/sources/path-policy.ts)에 걸림(`.git`, `.env`, `secrets`, `*.pem` 등) |
| `too-large` | `index.maxFileBytes` 초과 |
| `not-utf8` | 내용이 UTF-8로 해석되지 않음 |
| `not-utf8-path` | 경로 바이트가 UTF-8로 해석되지 않음. include·exclude·Markdown 검사를 통과한 경로만 기록하고, 근거·코드 연결로 해석하지 않는다. 기록되는 이름은 깨진 바이트를 `\xHH`로 바꾼 표시용 문자열이다 |
| `binary` | NUL 바이트 포함 |

건너뛴 문서는 `index` 결과의 `skipped`에 남고 검색 결과에는 `skipped-documents` 한계로 나타난다. `blocked-path`의 경로는 검색 결과에 싣지 않고 개수만 알린다.

## 분할

CRLF, LF, CR을 줄바꿈으로 인정하고 첫 BOM은 제거한다. 줄 번호는 1부터 센다.

| 단위 | 조건 |
|---|---|
| `document` | 첫 제목 앞의 본문(앵커 `_intro`). 제목이 하나도 없는 문서는 전체가 이 항목 하나다. 항목이 하나도 나오지 않는 문서라도 frontmatter에 `id`나 `status`가 있으면 문서 전체(1줄부터 끝까지)를 이 항목 하나로 만든다. 폐기 문서가 근거로 쓰이지 않고 frontmatter `id`를 참조할 수 있게 하기 위해서다 |
| `section` | ATX 또는 Setext 제목에서 다음 제목 전까지. 제목만 있고 본문이 없는 절은 항목을 만들지 않는다. 단, `=` 밑줄 Setext 제목은 문단을 제목으로 삼았으므로 본문이 없어도 항목을 만든다 |
| `entry` | 들여쓰기 없는 ``### `KEY` 제목`` 형식. 다음 1~2단계 제목 또는 백틱 키가 있는 3단계 제목 전까지이며, 그 안의 일반 `###`와 `####`는 항목에 포함된다. 키가 있으면 본문이 없어도 항목을 만든다 |

절끼리 겹치지 않는다. H2 본문은 그 아래 H3 본문을 포함하지 않는다. 코드 펜스, HTML 주석, `<pre>`·`<script>`·`<style>`·`<textarea>` 원시 HTML 블록 안의 제목은 무시한다. 각 항목 끝의 빈 줄은 범위에서 뺀다.

목록과 인용은 컨테이너로 추적한다. 목록 표시 줄(`-`, `*`, `+`, `1.`, `1)`)은 내용 오프셋(들여쓰기 + 표시 + 공백)을 쌓고, 그보다 덜 들여쓴 비어 있지 않은 줄이 오면 내린다. 펜스, HTML 주석, 원시 HTML 블록의 여는 표시는 현재 컨테이너의 내용 오프셋에서 3칸 이내 들여쓰기이면 인식한다. 목록 표시 바로 뒤(`` 1. ```bash ``)와 인용 접두사 뒤(`` > ``` ``)의 여는 표시도 같다. 닫는 펜스도 같은 기준이고, 블록을 담은 목록이나 인용이 끝나면 블록도 끝난다. ATX 제목은 컨테이너와 상관없이 줄 맨 앞에서 3칸 이내일 때만 인식한다.

Setext 제목은 앞 문단 전체(연속된 일반 텍스트 줄)를 제목과 시작 줄로 쓴다. 밑줄은 `=` 1개 이상 또는 `-` 2개 이상이다. 앞 줄이 목록·인용·제목·표·빈 줄이면 제목이 아니고, 목록 항목이나 인용문을 이어 가는 문단(lazy continuation 포함)도 제목이 되지 않는다. `-` 밑줄은 다음 제목이나 파일 끝 전에 본문 텍스트가 없으면(구분선 줄은 본문으로 치지 않는다) 제목이 아니라 구분선이고, 그 문단은 앞 절의 본문으로 남는다.

- 항목 ID는 `<sourceId>:<path>#<anchor>` 형식이다. 사용하는 쪽에서는 불투명한 문자열로 다룬다.
- 앵커는 제목을 슬러그로 만든 값이고 문서 안에서 유일하다. 겹치면 `-1`, `-2`를 붙인다. 항목의 앵커는 키에서 나온다.
- 항목 내용은 해당 줄을 그대로 `\n`으로 이어 붙인 값이다. CRLF 문서도 내용에서는 LF가 된다.

## 분류

항목 종류는 아래 값 중 하나다.

| 종류 | 설명 |
|---|---|
| `overview` | 시스템이나 프로젝트 개요 |
| `responsibility` | 책임 구분 |
| `glossary` | 용어 |
| `policy` | 정책 |
| `contract` | 프로젝트 간 계약 |
| `dependency` | 명시적 의존 관계 |
| `architecture` | 구조 |
| `convention` | 구현 관례 |
| `test-strategy` | 검증 방법 |
| `quality` | 품질·보안 기준 |
| `data-dictionary` | 데이터 사전 |
| `api-catalog` | API 목록 |
| `business-rule` | 업무 규칙 |
| `feature` | 기능 |
| `flow` | 업무 흐름 |
| `plan` | 계획 |
| `experience` | 과거 작업 경험 |
| `handoff` | 작업 인계 기록 |
| `reference` | 그 밖의 참고 자료 |

종류의 우선순위는 항목 필드, frontmatter, 원본 규칙, 원본의 `defaultKind`, `reference` 순이다. 잘못된 값은 진단 `unknown-kind`를 남기고 다음 순위로 넘어간다.

## 상태

| 상태 | 표시 | 뜻 | `confirmed` |
|---|---|---|---|
| `confirmed_policy` | 확정 정책 | 근거가 해석된 정책 | `true` |
| `verified_experience` | 검증된 경험 | 근거가 해석된 경험 | `true` |
| `observed_behavior` | 코드에서 관찰한 동작 | 현재 코드의 동작이며 승인된 정책이 아니다 | `false` |
| `unverified` | 미확인 자료 | 근거가 없거나 해석되지 않은 자료 | `false` |
| `deprecated` | 폐기된 자료 | 더 쓰지 않는 자료 | `false` |
| `conflicted` | 충돌 | 다른 항목과 충돌이 있는 자료 | `false` |

`knowledge.status`는 충돌을 겹쳐 본 유효 상태이고 `knowledge.baseStatus`는 그 전의 기본 상태다. 원본 근거 없이 코드가 `confirmed_policy`나 `verified_experience`를 부여하는 경로는 없다.

### 상태 표기

앞뒤 공백을 지우고 안쪽 공백을 하나로 줄이고 소문자로 바꾼 뒤 전체 일치로 비교한다. 목록에 없는 값은 상태가 없는 것으로 보고 진단 `unknown-status-value`를 남긴다. 그래서 `확정 예정`은 확정이 아니다.

| 상태 | 쓸 수 있는 값 |
|---|---|
| `confirmed_policy` | `confirmed_policy`, `confirmed`, `확정`, `확정 정책` |
| `observed_behavior` | `observed_behavior`, `observed`, `관찰`, `코드 관찰`, `코드에서 관찰한 동작` |
| `verified_experience` | `verified_experience`, `verified`, `검증됨`, `검증된 경험` |
| `unverified` | `unverified`, `미확인`, `가설`, `미확인 자료` |
| `deprecated` | `deprecated`, `폐기`, `폐기됨`, `대체됨`, `폐기된 자료` |

### 선언의 상속

절마다 자기 → 가까운 조상 절 순서 → frontmatter로 이어지는 사슬이 있다. 첫 제목 앞의 도입부(`document` 단위)는 사슬에 들지 않으므로 도입부의 필드는 그 항목에만 적용되고 절로 내려가지 않는다. HTML 주석이나 구분선뿐인 도입부는 항목을 만들지 않으며, frontmatter의 `id`·`aliases`·`title`은 다음 항목이 받는다.

| 대상 | 규칙 |
|---|---|
| 상태 | 사슬에서 처음 상태를 선언한 층의 값을 쓴다. 정식 필드가 없는 절의 비공식 표기도 선언으로 친다 |
| 근거 | 자기 층부터 위로 올라가며 근거가 있는 첫 층의 것을 쓴다. 상태를 선언하지 않았거나 상태 값을 정한 층과 같은 상태(정규화 결과)를 선언한 층의 근거만 쓰고, 다른 상태를 선언한 층은 건너뛴다. 그래서 상태를 물려받은 절이 스스로 적은 근거도 그 상태의 근거가 된다. 상태를 선언한 층이 없으면 사슬에서 가장 가까운 근거를 쓴다 |
| `충돌` | 조상 절의 `충돌` 대상을 하위 절이 물려받는다 |
| 필수 | 자기, 조상 절, frontmatter, 원본 규칙 중 하나라도 참이면 필수다 |
| 그 밖의 필드 | 조상 절에서 물려받지 않는다. `의존`, `계약`, `코드` 같은 다른 연결도 그 절에만 적용된다 |

frontmatter의 `relations`는 문서의 모든 항목에 더해진다. `applies_to`의 경로·전역, 단계, 조건은 항목에 같은 종류의 필드(`범위`, `단계`, `조건`)가 없을 때 쓴다.

### 비공식 표기

목록이 아닌 줄의 `상태: X`(`**상태**: X`처럼 강조를 둘러도 같다)와 칸이 둘인 표 행 `| 상태 | X |`(이름은 `상태` 또는 `status`)는 정식 필드가 아니다. X가 위 어휘로 정규화될 때만 의미가 있다.

| X의 정규화 결과 | 동작 |
|---|---|
| `deprecated`, `unverified`, `observed_behavior` | 그 절에 정식 상태가 없으면 이 값을 선언 상태로 쓴다. 표기가 여럿이면 `deprecated`, `unverified`, `observed_behavior` 순으로 먼저 있는 값을 쓴다 |
| `confirmed_policy`, `verified_experience` | 효과가 없다. 상태를 올리지 못한다 |
| 어휘 밖의 값 | 무시한다. 진단도 남기지 않는다 |

어휘로 읽히는 표기에는 올리지 못하는 경우까지 진단 `unrecognized-status-field`를 남긴다. `| 상태 | 설명 |`이나 `상태: 결제 완료 후 변경`은 어휘 밖이므로 아무 영향이 없다. 바로 다음 줄이 표 구분 행(`|---|---|`)이면 그 줄은 표 머리글이므로 값이 어휘에 있어도 비공식 표기로 보지 않는다.

### 기본 상태 판정

위에서부터 처음 맞는 줄이 결과다. `규칙`은 원본 규칙의 `status`를 뜻한다. 선언이 `unverified`나 `observed_behavior`이면 규칙이 있어도 선언을 따른다. 작성자가 낮게 표시한 항목을 운영자 규칙이 올려 주지 못하게 하기 위해서다. 어휘 밖의 값이 선언된 항목도 작성자의 뜻을 알 수 없으므로 규칙은 `deprecated`, `unverified`로 낮추는 경우에만 적용한다. 나머지 경우에는 규칙이 선언보다 우선한다.

| 조건 | 결과 | `knowledge.reason` |
|---|---|---|
| 선언이 `deprecated` | `deprecated` | `declared-deprecated` |
| 원문 값이 어휘 밖이고 규칙이 없거나 규칙이 `confirmed_policy`, `verified_experience`, `observed_behavior`임 | `unverified` | `unknown-status-value` |
| 선언과 규칙이 모두 없고 원문 값도 없음 | `unverified` | `status-not-declared` |
| 대상이 `unverified` | `unverified` | `declared`, `source-rule`, `declared-overrides-source-rule` |
| 규칙이 `deprecated` | `deprecated` | `source-rule` |
| 대상이 `observed_behavior`이고 코드·테스트 경로 또는 근거가 해석됨 | `observed_behavior` | `code-reference-resolved`, `basis-resolved`, `declared-overrides-source-rule` |
| 대상이 `observed_behavior`이고 해석된 것이 없음 | `unverified` | `observation-without-code-reference` |
| 대상이 `confirmed_policy` 또는 `verified_experience`이고 근거가 해석됨 | 대상 | `basis-resolved` |
| 규칙이 같은 상태이고 규칙의 `basis`가 있음 | 대상 | `source-rule` |
| 근거 참조는 있으나 해석되지 않음 | `unverified` | `status-basis-unresolved` |
| 근거 참조가 없음 | `unverified` | `status-basis-missing` |

규칙의 `basis`로 정해진 상태는 `knowledge.basis.resolution`이 `operator-declared`다. 운영자의 진술이지 해석된 원본이 아니라는 뜻이다.

### 근거 참조

항목의 `근거`, `출처`, `basis` 필드 또는 frontmatter `status_basis`에 쓴다. 공백, 쉼표, `·`로 나누되 백틱 구간은 공백이 있어도 나누지 않는 토큰 하나다(`` `a b.ts` ``, `` `path:a b.ts` ``). 값의 모든 토큰이 아래 형식의 참조이거나 경로 형태일 때만 토큰별로 읽는다. 하나라도 그렇지 않으면 값 전체를 하나의 `opaque`로 둔다. 문장 속의 경로 토큰이 근거가 되지 않게 하기 위해서다.

| 형식 | 해석되는 조건 |
|---|---|
| `path:<경로>[#앵커]`, 또는 `/`나 확장자를 포함한 토큰 | 같은 저장소의 해당 커밋에서 추적되는 일반 파일이고 항목 자신의 문서가 아니며, 아래 [`path` 근거의 제외](#path-근거의-제외)에 해당하지 않음 |
| `commit:<sha>` | 해당 저장소에 있는 커밋 |
| `item:<참조>` | 대상이 다른 문서에 있고, `item:` 근거를 뺀 대상의 상태가 `path` 근거를 다시 본 뒤에도 `confirmed_policy`나 `verified_experience`이며, 미리 계산한 대체·충돌에서 폐기되거나 충돌이 아님 |
| `verify:<단계>` | 형식만 인식하고 해석하지 않는다 |
| 그 밖의 값 | 해석하지 않는다 |

#### `path` 근거의 제외

대상이 색인된 문서이면 다음 경우에 해석되지 않는다. 대상이 색인되지 않은 파일이면 인용 관계도 상태도 없으므로 이 검사를 하지 않는다.

- 앵커가 대상 문서의 항목을 가리키는데 그 항목이 근거가 될 수 없음.
- 앵커가 없거나 일치하는 항목이 없는데 대상 문서의 모든 항목이 근거가 될 수 없음.
- 인용 그래프에서 대상 문서가 인용한 문서로 되돌아옴(직접·간접 순환). 간선은 문서 X의 항목이 `path` 근거로 문서 Y를 가리키는 관계다. 선언이나 원본 규칙으로 폐기된 항목의 인용은 간선에서 뺀다. 작성자가 `unverified`나 `observed_behavior`로 표시해 폐기 규칙이 적용되지 않은 항목의 인용은 남는다.

근거가 될 수 없는 항목은 선언 상태가 `deprecated`, `unverified`, 어휘 밖의 값이거나, 미리 계산한 상태가 폐기(선언, 원본 규칙, `superseded` 포함)이거나 충돌인 항목이다. 선언 상태가 없는 문서는 유효한 근거다.

#### 판정 순서

1. 경로·커밋 참조와 규칙으로 1차 상태를 정한다. 이때 `path` 근거는 대상의 선언 상태만 본다.
2. 1차 상태로 대체 처리와 충돌을 미리 계산한다.
3. 1차에서 확정된 항목을 포함해 모든 항목의 `path`와 `item:` 근거를 다시 본다. 대상이 2의 결과에서 폐기이거나 충돌이면 거부한다.
4. 최종 상태로 대체를 처리한다.
5. 최종 충돌을 찾는다.

`item:` 근거의 대상에는 다른 `item:` 근거로 올라간 상태를 쓰지 않으므로 `item:` 근거는 연쇄되지 않고 서로를 가리키는 순환이 스스로를 확정하지 못한다.

미리 계산은 3 전에 한 번만 한다. 3에서 상태가 바뀐 항목 때문에 뒤늦게 폐기되거나 충돌이 되는 대상을 이미 통과한 근거는 다시 보지 않는다.

### 대체

같은 프로젝트의 해석된 `대체`(`supersedes`) 연결을 처리한다. 앵커나 키 없이 문서 경로만 가리키는 대상은 그 문서의 모든 항목에 적용하되 대체자와 같은 문서의 항목은 제외한다. 대체 그래프의 강한 연결 요소 안에 있는 간선(자기 자신, 서로, 셋 이상의 고리)은 어느 쪽이 새것인지 알려 주지 않으므로 처리에서 뺀다. 문서 전체를 가리키는 선언은 펼친 간선 중 하나라도 고리에 들면 그 선언 전체를 뺀다. 두 문서가 서로를 대체한다고 적은 경우 어느 쪽 절도 폐기되지 않는다. 고리 밖의 항목을 가리키는 간선은 그대로 처리한다.

| 대체자의 기본 상태 | 대상 | 결과 |
|---|---|---|
| `confirmed_policy`, `verified_experience` | 어느 상태든 | 대상은 `deprecated`, `knowledge.reason`은 `superseded`, `knowledge.basis.refs`에 대체자가 `item` 참조로 남는다 |
| 그 밖의 비폐기 상태 | `confirmed_policy`, `verified_experience` | 대상을 폐기하지 않고 충돌 `unconfirmed-supersession`을 단다. `withItemIds`는 대체자이고 대상은 `confirmed:false`로 보인다 |
| 그 밖의 비폐기 상태 | 그 밖의 상태 | 바뀌지 않는다 |
| `deprecated` | 어느 상태든 | 아무 일도 없다 |

대체자의 상태는 이 처리 전의 값을 보므로 대체 사슬의 결과가 처리 순서에 좌우되지 않는다. 다른 프로젝트의 항목을 대체한다는 선언은 상태에 영향을 주지 않고 연결로만 남는다.

### 충돌

항목에 충돌이 하나라도 있으면 유효 상태가 `conflicted`가 되고 `confirmed`는 `false`다. 기본 상태는 `baseStatus`에 남는다. 충돌은 아래 네 가지로만 판정하고 내용을 보고 추측하지 않는다. 정책과 코드가 다른 경우는 작성자가 `충돌` 필드로 표시한다.

| `reason` | 조건 |
|---|---|
| `declared` | `충돌` 필드(`conflicts_with`)가 있음. 조상 절의 `충돌`도 포함한다. 대상이 해석되면 양쪽 모두, 해석되지 않으면 선언한 쪽이 표시된다. 대상이 선언한 항목 자신으로 해석되면 충돌로 치지 않고 연결로만 남는다 |
| `duplicate-key` | 같은 프로젝트에서 폐기되지 않은 항목 둘 이상이 같은 키를 씀 |
| `duplicate-contract-owner` | 폐기되지 않은 `contract` 항목이 둘 이상의 프로젝트에서 같은 키를 씀 |
| `unconfirmed-supersession` | 확정된 항목을 확정되지 않은 항목이 대체한다고 선언함([대체](#대체) 참고) |

중복 판정은 같은 프로젝트의 한쪽 방향 대체로 이어진 쌍을 제외한다. 프로젝트가 다르거나 대체 고리 안에 있는 쌍은 제외하지 않는다. `deprecated` 항목은 충돌 판정에서 빠지고 유효 상태도 `deprecated`로 유지된다.

## 필드 문법

### frontmatter

문서 첫 줄이 정확히 `---`이고 닫는 줄(`---` 또는 `...`)이 있으며, 영역이 아래 키 중 하나 이상(`fixture` 포함)을 가진 YAML 매핑일 때만 frontmatter로 읽는다. 그렇지 않으면 구분선으로 보고 영역을 본문으로 색인한다. YAML로 읽히지 않아 본문으로 돌렸을 때는 진단 `invalid-frontmatter`를 남긴다.

frontmatter로 읽었지만 키의 형식이 틀리면 진단 `invalid-frontmatter`를 남기고 문자열인 `status`와 형식이 맞는 `status_basis`만 살린다. 다른 키의 오류 때문에 폐기·미확인 선언을 잃지 않기 위해서다.

```yaml
---
id: DOC-KEY           # 문서 첫 항목에 키가 없으면 그 키가 된다
title: 제목
kind: policy
status: 미확인
status_basis: docs/source.md
mandatory: false
applies_to: {global: false, paths: [src/orders/], phases: [implement], conditions: 조건 문장}
relations: {policy: [POL-100], code: [src/a.ts]}
aliases: [별칭]
---
```

`relations`의 키는 `policy`, `feature`, `flow`, `contract`, `dependency`, `code`, `test`, `conflicts_with`, `supersedes`, `related`만 읽는다. `title`은 `id`, `aliases`처럼 문서 첫 항목의 별칭으로도 들어가 검색된다.

### 항목 필드

절, 항목, 문서 단위 항목의 본문에서 `- 이름: 값` 줄을 읽는다. 목록 표시는 `-`, `*`, `+`이고 전각 콜론(`：`)도 인정한다. 이름의 강조(`**상태**:`, `**상태:**`, `__상태__:`)는 벗긴다. 이름의 공백과 앞의 `관련`은 지운다. 같은 이름이 반복되면 공백으로 잇는다.

다음 줄은 내용에는 남지만 필드로 읽지 않는다.

- 코드 펜스 안의 줄
- HTML 주석의 줄(여러 줄 주석 포함)
- `<pre>`, `<script>`, `<style>`, `<textarea>` 원시 HTML 블록의 줄
- 들여쓰기 코드: 현재 컨테이너의 내용 오프셋에서 4칸 이상 들여쓰고(컨테이너가 없으면 4칸 이상 또는 탭), 직전이 빈 줄이거나 앞선 코드 줄인 줄

목록 아래의 중첩 필드(`- 메모` 다음의 `    - 상태: 확정`)는 계속 읽는다.

| 이름 | 의미 |
|---|---|
| `상태`, `status` | 선언 상태 |
| `근거`, `출처`, `basis` | 근거 참조 |
| `구분`, `mandatory` | 값이 `필수` 또는 `mandatory`이면 필수 지정. 그 밖의 값은 아니다 |
| `범위`, `scope` | `전체`, `전역`, `*`, `global`은 전역. 경로처럼 보이는 값은 적용 경로. 나머지는 조건 문장 |
| `단계`, `phase` | 작업 단계이면 적용 단계. 그 밖의 값은 흐름 연결 |
| `조건`, `적용조건` | 적용 조건 문장 |
| `별칭`, `aliases` | 쉼표나 `·`로 구분한 별칭 |
| `종류`, `kind` | 항목 종류 |
| `정책`, `기능`, `흐름`, `계약`, `의존`, `대체`, `충돌`, `연결` | 다른 항목으로의 연결 (`policy`, `feature`, `flow`, `contract`, `dependency`, `supersedes`, `conflicts_with`, `related`) |
| `코드`, `테스트` | 경로 연결 (`code`, `test`). `:줄번호`, `#조각`, `./`, 백틱을 지우고 http(s)는 제외한다 |

작업 단계는 `analysis`, `impact`, `design`, `plan`, `implement`, `check`, `test`, `review`, `integrate`, `deliver`다.

연결 대상은 백틱 안의 값과, 백틱 밖에서 `BR-`, `FEAT-`, `FLOW-`, `POL-`, `CON-`, `DEP-`로 시작하는 키다. 앞에 `<프로젝트>:`를 붙일 수 있다. `충돌`과 `의존`은 대상을 못 찾았고 값이 비어 있지 않으며 없음 표시가 아니면 원문 값 전체를 대상 하나로 쓴다. 자유문으로 적은 충돌은 미해결 대상으로 남아 `conflicted`가 되고, 자유문 의존은 `unresolved-links`로 나타난다.

없음 표시는 `없음`, `없습니다`, `없다`, `해당없음`, `해당사항없음`, `해당없습니다`, `none`, `n/a`, `na`, `nil`, `null`, `-`, `—`다. 공백과 대소문자는 가리지 않는다. 값이 표시로 끝나거나, 표시 뒤의 첫 글자가 문장부호·괄호이면 없음이다(`해당 없음.`, `없음 (검토 완료)`, `없음, 추후 검토`). 표시 뒤에 낱말이 이어지면 선언된 값이다(`NA 리전 정책`, `없음 처리 규칙과 상충`). `na-service`처럼 식별자에 쓰는 `-`, `_`, `.`, `/`, `:` 뒤에 글자가 이어져도 값의 일부다.

대상은 정확한 항목 ID, 다음으로 지정 프로젝트(없으면 자기 프로젝트)의 키, `path#anchor`, 경로 순으로 찾는다. 한 단계에서 여럿이 맞으면 하나를 고르지 않고 미해결(`ambiguous`)로 남긴다. 프로젝트를 쓰지 않은 대상은 다른 프로젝트로 넘어가서 찾지 않는다.

### 진단

문서 진단은 `index`의 stderr와 `status`의 `diagnostics`에 나온다. 색인을 막지는 않는다.

| 코드 | 조건 |
|---|---|
| `invalid-frontmatter` | 맨 앞 영역이 YAML로 읽히지 않았거나 frontmatter 키의 형식이 틀림 |
| `unknown-status-value` | 정식 상태 값이 어휘 밖임 |
| `unknown-kind` | 종류 값이 목록 밖임 |
| `unrecognized-status-field` | 상태 어휘로 읽히는 비공식 표기가 있음 |

원본 단위의 경고 `no-matching-documents`(`index`, `validate`)와 `dirty-tracked-documents`(`validate`)는 [retrieval.md](retrieval.md)에 적는다.

## 출처와 버전

결과의 `provenance`는 다음을 담는다.

| 필드 | 뜻 |
|---|---|
| `path`, `startLine`, `endLine` | 원본 상대 경로와 줄 범위(끝 줄 포함) |
| `excerptStartLine`, `excerptEndLine` | 발췌의 줄 범위 |
| `anchor` | 문서 안의 앵커 |
| `commit` | 색인 기준 커밋 |
| `blobSha` | Git 블롭 ID |
| `documentSha256` | 블롭 바이트의 SHA-256 |
| `itemSha256` | 항목 내용(UTF-8)의 SHA-256 |
| `parserVersion`, `chunkerVersion` | 파서와 분할 규칙 버전 |
| `generation`, `firstGeneration` | 조회한 세대와 이 문서가 처음 색인된 세대 |

### 세대

색인은 세대 단위로 원자적으로 게시한다.

- 수집과 문서 분석은 트랜잭션 밖에서 하고, 게시는 한 번의 쓰기 트랜잭션으로 한다. 어느 원본이든 실패하면 실행 전체가 중단되고 활성 세대는 그대로다.
- 원본의 커밋, 수집 규칙, 파서 계열 버전을 합친 지문이 활성 세대와 같으면 새 세대를 만들지 않고 `unchanged`로 끝난다.
- 내용이 같은 문서는 다시 분석하지 않고 재사용한다. 상태·충돌·연결은 세대마다 다시 계산한다.
- 세대 번호는 계속 증가하며 `index.retainGenerations`(활성 세대 포함)보다 오래된 세대는 삭제한다. 원본이 그대로여서 `unchanged`로 끝나는 실행에서도 보존 수를 넘으면 삭제한다.
- 여러 저장소를 함께 쓰면 원본별 기준 커밋을 세대마다 기록한다. `index` 결과의 `commits`와 검색 결과의 `index.sources`에서 볼 수 있다.

### 버전

상수는 `src/parsing/versions.ts`에 있다. 상수를 올리면 다음 `index` 실행에서 지문이 달라져 새 세대가 게시된다.

| 상수 | 바꾼 것 | 다시 만들어지는 것 |
|---|---|---|
| `PARSER_VERSION` | Markdown·frontmatter·필드 문법 해석 | 문서 분석과 항목 |
| `CHUNKER_VERSION` | 절·항목 경계, 앵커 규칙 | 문서 분석과 항목. 벡터 점 ID도 달라진다 |
| `TOKENIZER_VERSION` | 토크나이저, 색인 열 구성 | 문서 분석과 FTS 색인 |
| `RESOLVER_VERSION` | 상태·충돌·연결 해석 규칙 | 세대별 판정 결과. 문서 분석은 재사용한다 |

SQLite 스키마가 오래된 DB를 읽으면 `index-missing`(`schema-mismatch`)이 나고 `index`를 실행하면 마이그레이션된다.
