import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import {
  EXIT_CODES,
  getAny,
  getItem,
  getItemV2,
  KnowledgeError,
  openKnowledgeBase,
  RESPONSE_VERSIONS,
  SCHEMA_VERSION,
  search,
  searchAny,
  searchV2,
  verifyReferences,
  type ErrorCode,
  type GetRequest,
  type GetResponse,
  type GetResponseV2,
  type RetrievalContext,
  type SearchRequest,
  type SearchRequestV2,
  type SearchResponseV2,
} from '../src/index.js';
import { compareStrings } from '../src/util/compare.js';
import { commit, knowledgeFixture, makeRepo, TempSpace, tempSpace, type KnowledgeFixture } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));

const ORDERS = {
  'docs/policies.md': [
    '---',
    'kind: policy',
    '---',
    '# 주문 정책',
    '',
    '### `POL-1` 카드 저장 금지',
    '',
    '- 구분: 필수',
    '',
    '카드 번호 원문을 저장하지 않는다. 결제 승인 기록에도 남기지 않는다.',
    '',
    '### `POL-2` 주문 취소',
    '',
    '- 연결: BR-10',
    '',
    '배송 전 주문은 취소할 수 있다. 결제 승인 취소를 함께 요청한다.',
    '',
  ].join('\n'),
  'docs/deps.md': ['# 의존 관계', '', '### `DEP-1` 결제 계약 의존', '', '- 종류: dependency', '- 계약: billing:CON-1', '', '주문은 결제 승인 계약에 의존한다.', ''].join('\n'),
  'docs/rules.md': [
    '---',
    'kind: business-rule',
    '---',
    '# 업무 규칙',
    '',
    '### `BR-10` 환불 규칙',
    '',
    '환불은 결제 승인 취소 뒤에 한다.',
    '',
    '### `BR-11` 배송 규칙',
    '',
    '- 연결: billing:CON-2',
    '',
    '배송은 영업일 기준 이틀이 걸린다.',
    '',
  ].join('\n'),
};

const BILLING = {
  'docs/contract.md': [
    '---',
    'kind: contract',
    '---',
    '# 결제 계약',
    '',
    '### `CON-1` 결제 승인 계약',
    '',
    '- 연결: CON-2',
    '',
    '결제 승인 요청 형식을 정한다. 배송 정보는 받지 않는다.',
    '',
    '### `CON-2` 결제 취소 계약',
    '',
    '결제 취소 요청 형식을 정한다.',
    '',
  ].join('\n'),
  'docs/policy.md': '---\nkind: policy\n---\n# 정산 정책\n\n- 구분: 필수\n\n정산은 매일 한다. 결제 승인 건만 정산한다.\n',
};

const POLICY_ID = 'orders:docs/policies.md#POL-1';
const CANCEL_ID = 'orders:docs/policies.md#POL-2';
const CONTRACT_ID = 'billing:docs/contract.md#CON-1';
const HEX32 = /^[0-9a-f]{32}$/;

/** 기준 커밋(695de23)의 status·index 출력 키. 형식 1은 이 집합에서 벗어나면 안 된다. */
const STATUS_V1_KEYS = ['schema', 'schemaVersion', 'ok', 'status', 'activeGeneration', 'retainedGenerations', 'sources', 'counts', 'runs', 'lastFailure', 'vector', 'diagnostics', 'diagnosticsTotal'];
const STATUS_V2_EXTRA = ['indexId', 'databaseSchemaVersion', 'generations', 'leases'];
const INDEX_V1_KEYS = ['schema', 'schemaVersion', 'ok', 'status', 'generation', 'runId', 'documentCount', 'itemCount', 'sources', 'commits'];
const INDEX_V2_EXTRA = ['indexId', 'fingerprint', 'activated', 'activeGeneration', 'lease'];
const INDEX_SOURCE_V1_KEYS = ['sourceId', 'projectId', 'requestedRef', 'commit', 'documentCount', 'added', 'reused', 'removed', 'skipped'];
const STATUS_SOURCE_KEYS = ['sourceId', 'projectId', 'commit', 'requestedRef', 'documentCount', 'upToDate'];
const RETAINED_KEYS = ['generation', 'publishedAt', 'documentCount', 'itemCount'];
const RUN_KEYS = ['runId', 'startedAt', 'finishedAt', 'status', 'generation', 'errorCode'];

/** 형식 1 출력 어디에도 나오면 안 되는 형식 2 전용 키. */
const V2_ONLY_KEYS = ['responseVersion', 'queries', 'ranker', 'segments', 'include', 'quota', 'budget', 'digests', 'group', 'mandatory', 'segment', 'operations', 'declaration', 'directRank', 'matchedQueries', 'ref', 'indexId', 'scopeFingerprint', 'activated', 'refOrigin', 'outcome', 'configHash', 'composition', 'liveLeases', 'leases', 'lease', 'databaseSchemaVersion', 'segmentContent'];

function sorted(values: Iterable<string>): string[] {
  return [...values].sort(compareStrings);
}

function keysOf(value: object): string[] {
  return sorted(Object.keys(value));
}

function allKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) allKeys(entry, found);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      found.add(key);
      allKeys(entry, found);
    }
  }
  return found;
}

function assertNoV2Keys(value: unknown, label: string): void {
  const leaked = V2_ONLY_KEYS.filter((key) => allKeys(value).has(key));
  assert.deepEqual(leaked, [], `${label} leaks v2-only keys`);
}

/** narrow의 모든 키가 같은 값으로 wide에 있어야 한다. 배열은 길이와 순서까지 같아야 한다. */
function assertSuperset(narrow: unknown, wide: unknown, path: string): void {
  if (Array.isArray(narrow)) {
    assert.ok(Array.isArray(wide), `${path} is not an array`);
    assert.equal(wide.length, narrow.length, `${path} length`);
    narrow.forEach((entry, index) => assertSuperset(entry, wide[index], `${path}[${index}]`));
    return;
  }
  if (typeof narrow === 'object' && narrow !== null) {
    assert.ok(typeof wide === 'object' && wide !== null && !Array.isArray(wide), `${path} is not an object`);
    for (const [key, entry] of Object.entries(narrow)) {
      assert.ok(Object.hasOwn(wide, key), `${path}.${key} missing in v2`);
      assertSuperset(entry, (wide as Record<string, unknown>)[key], `${path}.${key}`);
    }
    return;
  }
  assert.equal(wide, narrow, path);
}

function failure(fn: () => unknown, code: ErrorCode): KnowledgeError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof KnowledgeError, String(error));
    assert.equal(error.code, code, `${error.message} ${JSON.stringify(error.detail)}`);
    return error;
  }
  return assert.fail(`expected ${code}`);
}

function corpus(t: TestContext): KnowledgeFixture {
  const fixture = knowledgeFixture(t, [
    { id: 'orders', files: ORDERS },
    { id: 'billing', files: BILLING },
  ]);
  fixture.index();
  return fixture;
}

function asV2(request: SearchRequest): SearchRequestV2 {
  const { responseVersion: _omitted, ...rest } = request;
  return { ...rest, responseVersion: 2 };
}

function userVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

function metaIndexId(dbPath: string): string | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT value FROM meta WHERE key = 'index_id'").get() as { value: string } | undefined)?.value ?? null;
  } finally {
    db.close();
  }
}

/**
 * 현재 코드로 만든 색인을 스키마 1 색인처럼 되돌린다(MIGRATIONS[1]의 역). preUpgrade면 세대와 문서도 md-1 시절 것처럼 꾸며
 * 다음 index가 그 세대를 재사용하지 않고 새 세대를 게시하게 한다.
 */
function downgradeToSchema1(dbPath: string, preUpgrade = false): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
DROP TABLE item_segments;
DROP TABLE segments_fts;
DROP TABLE generation_leases;
ALTER TABLE items DROP COLUMN token_count;
ALTER TABLE items DROP COLUMN operations_json;
ALTER TABLE items DROP COLUMN declaration_json;
ALTER TABLE generations DROP COLUMN activated;
ALTER TABLE generation_sources DROP COLUMN ref_origin;
ALTER TABLE generation_sources DROP COLUMN config_sha256;
DELETE FROM meta WHERE key = 'index_id';
`);
    if (preUpgrade) {
      db.exec(`
UPDATE generations SET parser_version = 'md-1', chunker_version = 'chunk-1', fingerprint = 'pre-upgrade-' || fingerprint;
UPDATE documents SET parse_fingerprint = 'pre-upgrade-' || parse_fingerprint;
`);
    }
    db.exec('PRAGMA user_version=1');
  } finally {
    db.close();
  }
}

function columnsOf(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return sorted((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
  } finally {
    db.close();
  }
}

function tablesOf(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return sorted((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
  } finally {
    db.close();
  }
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  doc: Record<string, any>;
}

function spawnCli(args: readonly string[], input?: string): Omit<Run, 'doc'> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_KNOWLEDGE_')));
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, input, env });
  assert.equal(result.error, undefined);
  return { status: result.status!, stdout: result.stdout, stderr: result.stderr };
}

function run(args: readonly string[], input?: string): Run {
  const result = spawnCli(args, input);
  assert.equal(result.stdout.trimEnd().includes('\n'), false, `expected one line: ${result.stdout}`);
  return { ...result, doc: JSON.parse(result.stdout) as Record<string, any> };
}

function assertCliFailure(result: Run, code: ErrorCode, reason?: string): void {
  assert.equal(result.doc.schema, 'agent-knowledge.error', result.stdout);
  assert.equal(result.doc.ok, false);
  assert.equal(result.doc.error.code, code, result.stdout);
  assert.equal(result.status, EXIT_CODES[code], result.stdout);
  if (reason !== undefined) assert.equal(result.doc.error.detail.reason, reason, result.stdout);
}

interface Workspace {
  space: TempSpace;
  config: string;
  dbPath: string;
  orders: string;
  billing: string;
}

function buildWorkspace(space: TempSpace): Workspace {
  const orders = makeRepo(space.path('orders'), ORDERS);
  const billing = makeRepo(space.path('billing'), BILLING);
  const config = space.path('sources.yaml');
  writeFileSync(
    config,
    stringify({
      schemaVersion: 1,
      database: { path: './k.sqlite' },
      sources: [
        { id: 'orders', project: 'orders', path: orders, include: ['docs/**/*.md'] },
        { id: 'billing', project: 'billing', path: billing, include: ['docs/**/*.md'] },
      ],
    }),
  );
  return { space, config, dbPath: space.path('k.sqlite'), orders, billing };
}

function searchArgs(config: string, extra: readonly string[] = ['--query', '결제 승인']): string[] {
  return ['search', '--config', config, '--profile', 'master', '--project', 'orders', '--allow-link', 'billing', ...extra];
}

const LINKED_SCOPE = { projects: ['orders'], allowedLinks: [{ project: 'billing' }] };

const DEFAULT_REQUESTS: [string, SearchRequest][] = [
  ['linked scope, shared words', { profile: 'master', query: '결제 승인', scope: LINKED_SCOPE }],
  ['linked scope, cancel', { profile: 'master', query: '취소', scope: LINKED_SCOPE }],
  ['linked scope, explicit key', { profile: 'master', query: 'BR-10', scope: LINKED_SCOPE }],
  ['linked scope, no direct match', { profile: 'master', query: '없는단어입니다', scope: LINKED_SCOPE }],
  ['two projects', { profile: 'master', query: '결제 승인', scope: { projects: ['billing', 'orders'] } }],
  ['two projects, small limit', { profile: 'master', query: '결제', scope: { projects: ['orders', 'billing'] }, limit: 2 }],
  ['kind filter', { profile: 'master', query: '결제 승인', scope: LINKED_SCOPE, filters: { kinds: ['policy', 'contract'] } }],
  ['code profile with task paths', { profile: 'code', query: '배송 취소', scope: LINKED_SCOPE, task: { phase: 'implement', paths: ['src/orders.ts'] } }],
  ['pinned generation', { profile: 'master', query: '결제 승인', scope: LINKED_SCOPE, version: { generation: 1 } }],
];

describe('response version 1 stays byte-identical', () => {
  it('gives the same bytes with and without responseVersion 1 in the library', (t) => {
    const { context } = corpus(t);
    for (const [name, request] of DEFAULT_REQUESTS) {
      const omitted = JSON.stringify(search(context, request));
      assert.equal(JSON.stringify(search(context, { ...request, responseVersion: 1 })), omitted, name);
      assert.equal(JSON.stringify(searchAny(context, { ...request, responseVersion: 1 })), omitted, name);
      assert.equal(JSON.stringify(searchAny(context, request)), omitted, name);
    }
    const get: GetRequest = { id: POLICY_ID, profile: 'master', scope: LINKED_SCOPE };
    const plain = JSON.stringify(getItem(context, get));
    assert.equal(JSON.stringify(getItem(context, { ...get, responseVersion: 1 })), plain);
    assert.equal(JSON.stringify(getAny(context, { ...get, responseVersion: 1 })), plain);
  });

  it('keeps v2-only keys out of every v1 search and get', (t) => {
    const { context } = corpus(t);
    for (const [name, request] of DEFAULT_REQUESTS) {
      const response = search(context, request);
      assert.equal(response.schemaVersion, 1, name);
      assertNoV2Keys(response, name);
    }
    for (const id of [POLICY_ID, CANCEL_ID, CONTRACT_ID]) {
      const response = getItem(context, { id, profile: 'master', scope: LINKED_SCOPE });
      assert.equal(response.schemaVersion, 1);
      assertNoV2Keys(response, id);
    }
  });

  it('prints the same stdout with and without --response-version 1', (t) => {
    const { config, space } = buildWorkspace(tempSpace(t));
    assert.equal(run(['index', '--config', config]).status, 0);

    for (const extra of [['--query', '결제 승인'], ['--query', '없는단어입니다'], ['--query', '취소', '--kind', 'policy', '--limit', '3']]) {
      const plain = spawnCli(searchArgs(config, extra));
      const explicit = spawnCli(searchArgs(config, [...extra, '--response-version', '1']));
      assert.equal(explicit.status, plain.status, extra.join(' '));
      assert.equal(explicit.stdout, plain.stdout, extra.join(' '));
      assert.equal(JSON.parse(plain.stdout).schemaVersion, 1);
    }

    const request = { profile: 'master', query: '결제 승인', scope: LINKED_SCOPE };
    const bare = space.path('bare.json');
    const declared = space.path('declared.json');
    writeFileSync(bare, JSON.stringify(request));
    writeFileSync(declared, JSON.stringify({ ...request, responseVersion: 1 }));
    const fromFlags = spawnCli(searchArgs(config)).stdout;
    assert.equal(spawnCli(['search', '--config', config, '--request', bare]).stdout, fromFlags);
    assert.equal(spawnCli(['search', '--config', config, '--request', declared]).stdout, fromFlags);
    assert.equal(spawnCli(['search', '--config', config, '--request', declared, '--response-version', '1']).stdout, fromFlags);
    assert.equal(spawnCli(['search', '--config', config, '--request', '-', '--response-version', '1'], JSON.stringify(request)).stdout, fromFlags);

    const getFlags = ['get', '--config', config, '--id', POLICY_ID, '--profile', 'master', '--project', 'orders'];
    const got = spawnCli(getFlags);
    assert.equal(got.status, 0, got.stdout);
    assert.equal(spawnCli([...getFlags, '--response-version', '1']).stdout, got.stdout);
  });
});

describe('v2 with default options selects what v1 selects', () => {
  it('fixture exercises mandatory, dependency and linked groups', (t) => {
    const { context } = corpus(t);
    const response = search(context, { profile: 'master', query: '취소', scope: LINKED_SCOPE });
    const section = (id: string) => response.sections.find((entry) => entry.id === id)!.itemIds;
    assert.deepEqual(section('mandatory'), [POLICY_ID]);
    assert.deepEqual(section('dependencies'), ['orders:docs/deps.md#DEP-1']);
    assert.ok(response.items.some((item) => item.selection.reasons.some((reason) => reason.startsWith('linked:'))), JSON.stringify(response.items.map((item) => item.selection.reasons)));
    assert.ok(response.items.some((item) => item.projectId === 'billing'));
  });

  for (const [name, request] of DEFAULT_REQUESTS) {
    it(`matches v1 ids, order, sections and fields: ${name}`, (t) => {
      const { context } = corpus(t);
      const v1 = search(context, request);
      for (const v2Request of [asV2(request), { ...asV2(request), ranker: 'legacy' as const, segments: false, include: { mandatory: true, dependencies: true, links: true } }]) {
        const v2 = searchV2(context, v2Request);
        assert.equal(v2.schemaVersion, 2);
        assert.deepEqual(v2.items.map((item) => item.id), v1.items.map((item) => item.id));
        assert.deepEqual(v2.sections, v1.sections);
        assert.equal(v2.status, v1.status);
        assert.equal(v2.budget.truncated, false);
        assert.equal(v2.budget.omittedCount, 0);
        for (const group of ['mandatory', 'dependencies'] as const) {
          assert.deepEqual(v2.items.filter((item) => item.group === group).map((item) => item.id), v1.sections.find((section) => section.id === group)!.itemIds, group);
        }
        assert.deepEqual(v2.items.filter((item) => item.group === 'direct').map((item) => item.selection.directRank), v2.items.filter((item) => item.group === 'direct').map((_, index) => index + 1));
        assert.equal(v2.retrieval.directCount, v1.retrieval.directCount);
        // 형식 2는 형식 1의 키를 같은 뜻으로 두고 키만 더한다
        const { schemaVersion: _v1Version, ...v1Rest } = v1;
        assertSuperset(v1Rest, v2, 'search');
        assert.equal(JSON.stringify(searchAny(context, v2Request)), JSON.stringify(v2));
      }
    });
  }

  it('reports outcome consistently with the v1 status', (t) => {
    const { context } = corpus(t);
    const matched = searchV2(context, asV2({ profile: 'master', query: '결제 승인', scope: LINKED_SCOPE }));
    assert.equal(matched.retrieval.outcome, 'matched');
    const supplementary = searchV2(context, asV2({ profile: 'master', query: '없는단어입니다', scope: LINKED_SCOPE }));
    assert.equal(supplementary.retrieval.outcome, 'supplementary-only');
    assert.equal(supplementary.status, search(context, { profile: 'master', query: '없는단어입니다', scope: LINKED_SCOPE }).status);
    // 종류 필터로 필수 정책을 빼면 직접 일치도 보충 자료도 없다
    const nothing: SearchRequest = { profile: 'master', query: '없는단어입니다', scope: { projects: ['billing'] }, filters: { kinds: ['contract'] } };
    const emptyV1 = search(context, nothing);
    const empty = searchV2(context, asV2(nothing));
    assert.equal(emptyV1.status, 'no-results');
    assert.equal(empty.status, 'no-results');
    assert.equal(empty.retrieval.outcome, 'no-results');
    assert.deepEqual(empty.items, []);
  });

  it('extends v1 get without changing its fields', (t) => {
    const { context } = corpus(t);
    for (const id of [POLICY_ID, CANCEL_ID, CONTRACT_ID, 'orders:docs/rules.md#BR-11']) {
      const request: GetRequest = { id, profile: 'master', scope: LINKED_SCOPE };
      const v1: GetResponse = getItem(context, request);
      const v2: GetResponseV2 = getItemV2(context, { ...request, responseVersion: 2 });
      assert.equal(v2.schemaVersion, 2);
      assert.equal(v2.item.group, 'lookup');
      assert.equal(v2.item.segment, null);
      assert.equal(v2.item.segmentContent, null);
      const { schemaVersion: _v1Version, ...v1Rest } = v1;
      assertSuperset(v1Rest, v2, id);
    }
  });
});

describe('request version negotiation', () => {
  const base: SearchRequest = { profile: 'master', query: '결제', scope: { projects: ['orders'] } };
  // 색인이 없는 문맥이다. 형식 검사가 색인 접근보다 먼저여야 index-missing이 아니라 invalid-request가 나온다
  function noIndex(t: TestContext): RetrievalContext {
    const fixture = knowledgeFixture(t, [{ id: 'orders', files: ORDERS }]);
    assert.equal(existsSync(fixture.dbPath), false);
    return fixture.context;
  }

  const V2_FIELDS: [string, Record<string, unknown>][] = [
    ['queries', { queries: ['결제'] }],
    ['overflow', { overflow: 'error' }],
    ['ranker', { ranker: 'legacy' }],
    ['segments', { segments: false }],
    ['include', { include: {} }],
    ['quota', { quota: {} }],
    ['budget', { budget: {} }],
    ['filters.documents', { filters: { documents: ['docs/policies.md'] } }],
    ['version.indexId', { version: { indexId: '0'.repeat(32) } }],
    ['version.exact', { version: { generation: 1, exact: false } }],
  ];

  for (const [field, extra] of V2_FIELDS) {
    it(`refuses the v2-only field ${field} in a v1 search before touching the index`, (t) => {
      const context = noIndex(t);
      for (const request of [{ ...base, ...extra }, { ...base, ...extra, responseVersion: 1 }]) {
        for (const call of [() => search(context, request), () => searchAny(context, request), () => openKnowledgeBase({ dbPath: context.dbPath }).search(request as SearchRequest)]) {
          const error = failure(call, 'invalid-request');
          assert.deepEqual(error.detail, { reason: 'response-version-2-required', fields: [field] });
        }
      }
    });
  }

  it('lists every v2-only field of a v1 search in a fixed order', (t) => {
    const context = noIndex(t);
    const request = { ...base, ...Object.assign({}, ...V2_FIELDS.slice(0, 7).map(([, extra]) => extra)), filters: { kinds: ['policy'], documents: ['docs/a.md'] }, version: { generation: 1, indexId: '0'.repeat(32), exact: true } };
    const error = failure(() => searchAny(context, request), 'invalid-request');
    assert.deepEqual(error.detail, { reason: 'response-version-2-required', fields: V2_FIELDS.map(([field]) => field) });
  });

  it('accepts the same fields once responseVersion is 2', (t) => {
    const { context } = corpus(t);
    const request = { ...base, responseVersion: 2, queries: ['승인'], overflow: 'error', ranker: 'legacy', segments: false, include: {}, quota: {}, budget: {}, filters: { documents: ['docs/'] }, version: { generation: 1, exact: true } };
    const response = searchAny(context, request) as SearchResponseV2;
    assert.equal(response.schemaVersion, 2);
    assert.equal(response.index.selection.exact, true);
  });

  for (const value of [3, 0, -1, 1.5, '2', '1', null, true, [2], { v: 2 }]) {
    it(`refuses unsupported responseVersion ${JSON.stringify(value)}`, (t) => {
      const context = noIndex(t);
      const searchRequest = { ...base, responseVersion: value };
      const getRequest = { id: POLICY_ID, profile: 'master', scope: { projects: ['orders'] }, responseVersion: value };
      for (const call of [() => search(context, searchRequest), () => searchAny(context, searchRequest), () => searchV2(context, searchRequest)]) {
        const error = failure(call, 'invalid-request');
        assert.deepEqual(error.detail, { reason: 'unsupported-response-version', requested: value, supported: [1, 2] });
      }
      for (const call of [() => getItem(context, getRequest), () => getAny(context, getRequest), () => getItemV2(context, getRequest)]) {
        const error = failure(call, 'invalid-request');
        assert.deepEqual(error.detail, { reason: 'unsupported-response-version', requested: value, supported: [1, 2] });
      }
    });
  }

  it('sends v2 requests away from the v1 entry points', (t) => {
    const context = noIndex(t);
    const kb = openKnowledgeBase({ dbPath: context.dbPath });
    const searchRequest = { ...base, responseVersion: 2 };
    for (const call of [() => search(context, searchRequest), () => kb.search(searchRequest as unknown as SearchRequest)]) {
      assert.deepEqual(failure(call, 'invalid-request').detail, { reason: 'use-search-v2' });
    }
    const getRequest = { id: POLICY_ID, profile: 'master', scope: { projects: ['orders'] }, responseVersion: 2 };
    for (const call of [() => getItem(context, getRequest), () => kb.getItem(getRequest as unknown as GetRequest)]) {
      assert.deepEqual(failure(call, 'invalid-request').detail, { reason: 'use-get-v2' });
    }
  });

  it('sends v1 requests away from the v2 entry points', (t) => {
    const context = noIndex(t);
    const kb = openKnowledgeBase({ dbPath: context.dbPath });
    for (const request of [base, { ...base, responseVersion: 1 }]) {
      for (const call of [() => searchV2(context, request), () => kb.searchV2(request as unknown as SearchRequestV2)]) {
        assert.deepEqual(failure(call, 'invalid-request').detail, { reason: 'response-version-2-required', fields: ['responseVersion'] });
      }
    }
    const getRequest = { id: POLICY_ID, profile: 'master', scope: { projects: ['orders'] } };
    for (const request of [getRequest, { ...getRequest, responseVersion: 1 }]) {
      assert.deepEqual(failure(() => getItemV2(context, request), 'invalid-request').detail, { reason: 'response-version-2-required', fields: ['responseVersion'] });
    }
  });

  it('refuses expect in a v1 get before touching the index', (t) => {
    const context = noIndex(t);
    const request = { id: POLICY_ID, profile: 'master', scope: { projects: ['orders'] }, expect: { itemSha256: 'a'.repeat(64) } };
    for (const call of [() => getItem(context, request), () => getAny(context, request), () => getAny(context, { ...request, responseVersion: 1 })]) {
      assert.deepEqual(failure(call, 'invalid-request').detail, { reason: 'response-version-2-required', fields: ['expect'] });
    }
  });

  it('refuses version.indexId and version.exact in a v1 get with the v2 reason', (t) => {
    const context = noIndex(t);
    const scope = { projects: ['orders'] };
    for (const [fields, version] of [
      [['version.indexId'], { indexId: '0'.repeat(32) }],
      [['version.exact'], { generation: 1, exact: true }],
    ] as const) {
      const error = failure(() => getAny(context, { id: POLICY_ID, profile: 'master', scope, version }), 'invalid-request');
      assert.deepEqual(error.detail, { reason: 'response-version-2-required', fields }, JSON.stringify(error.detail));
    }
  });
});

describe('CLI --response-version', () => {
  let state: Workspace;

  before(() => {
    state = buildWorkspace(new TempSpace());
    const indexed = run(['index', '--config', state.config]);
    assert.equal(indexed.status, 0, indexed.stdout);
  });

  after(() => state.space.dispose());

  const requestFile = (name: string, body: unknown): string => {
    const path = state.space.path(name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };
  const searchBody = { profile: 'master', query: '결제 승인', scope: LINKED_SCOPE };
  const getBody = { id: POLICY_ID, profile: 'master', scope: LINKED_SCOPE };

  it('upgrades a request file to v2 with --response-version 2', () => {
    const v1 = run(['search', '--config', state.config, '--request', requestFile('s1.json', searchBody)]);
    for (const file of [requestFile('s2.json', searchBody), requestFile('s3.json', { ...searchBody, responseVersion: 2 })]) {
      const result = run(['search', '--config', state.config, '--request', file, '--response-version', '2']);
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.doc.schemaVersion, 2);
      assert.equal(result.doc.request.responseVersion, 2);
      assert.deepEqual(result.doc.items.map((item: { id: string }) => item.id), v1.doc.items.map((item: { id: string }) => item.id));
    }
    const fromStdin = run(['search', '--config', state.config, '--request', '-', '--response-version', '2'], JSON.stringify(searchBody));
    assert.equal(fromStdin.doc.schemaVersion, 2);

    const withV2Fields = run(['search', '--config', state.config, '--request', requestFile('s4.json', { ...searchBody, ranker: 'bm25', budget: { maxItems: 1 } }), '--response-version', '2']);
    assert.equal(withV2Fields.status, 0, withV2Fields.stdout);
    assert.equal(withV2Fields.doc.items.length, 1);
    assert.equal(withV2Fields.doc.retrieval.ranker.name, 'bm25');

    for (const body of [getBody, { ...getBody, responseVersion: 2 }]) {
      const got = run(['get', '--config', state.config, '--request', requestFile('g.json', body), '--response-version', '2']);
      assert.equal(got.status, 0, got.stdout);
      assert.equal(got.doc.schemaVersion, 2);
      assert.equal(got.doc.item.id, POLICY_ID);
      assert.match(got.doc.item.ref.indexId, HEX32);
    }
    const flags = run(['get', '--config', state.config, '--id', POLICY_ID, '--profile', 'master', '--project', 'orders', '--response-version', '2']);
    assert.equal(flags.doc.schemaVersion, 2);
  });

  it('reports a flag that disagrees with the request file as a usage error', () => {
    const cases: [string, unknown, string][] = [
      ['search', { ...searchBody, responseVersion: 2 }, '1'],
      ['search', { ...searchBody, responseVersion: 1 }, '2'],
      ['get', { ...getBody, responseVersion: 2 }, '1'],
      ['get', { ...getBody, responseVersion: 1 }, '2'],
      ['search', { ...searchBody, responseVersion: 3 }, '2'],
    ];
    for (const [command, body, flag] of cases) {
      const result = run([command, '--config', state.config, '--request', requestFile('conflict.json', body), '--response-version', flag]);
      assertCliFailure(result, 'usage');
      assert.equal(result.doc.command, command);
    }
  });

  it('reports an unknown --response-version value as a usage error on every command that takes it', () => {
    for (const value of ['3', '0', 'v2', '2.0', ' 2', '']) {
      const commands = [
        searchArgs(state.config, ['--query', '결제', '--response-version', value]),
        ['get', '--config', state.config, '--id', POLICY_ID, '--profile', 'master', '--project', 'orders', '--response-version', value],
        ['status', '--config', state.config, '--response-version', value],
        ['index', '--config', state.config, '--response-version', value],
      ];
      for (const args of commands) {
        const result = run(args);
        assertCliFailure(result, 'usage');
        assert.equal(result.doc.error.detail.flag, 'response-version', result.stdout);
      }
    }
    // --response-version을 받지 않는 명령은 옵션 자체를 모른다
    assertCliFailure(run(['validate', '--config', state.config, '--response-version', '2']), 'usage');
    assertCliFailure(run(['capabilities', '--response-version', '2']), 'usage');
  });

  it('passes a v1 request file with v2 fields through to the v1 validator', () => {
    const file = requestFile('mixed.json', { ...searchBody, queries: ['결제'] });
    for (const extra of [[], ['--response-version', '1']]) {
      const result = run(['search', '--config', state.config, '--request', file, ...extra]);
      assertCliFailure(result, 'invalid-request', 'response-version-2-required');
      assert.deepEqual(result.doc.error.detail.fields, ['queries']);
    }
    const unsupported = run(['search', '--config', state.config, '--request', requestFile('three.json', { ...searchBody, responseVersion: 3 })]);
    assertCliFailure(unsupported, 'invalid-request', 'unsupported-response-version');
    const expect = run(['get', '--config', state.config, '--request', requestFile('expect.json', { ...getBody, expect: { itemSha256: 'a'.repeat(64) } })]);
    assertCliFailure(expect, 'invalid-request', 'response-version-2-required');
  });

  it('announces the response versions it accepts without a database', () => {
    const result = run(['capabilities', '--db', state.space.path('absent.sqlite')]);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.doc.commands.search.responseVersions, [1, 2]);
    assert.deepEqual(result.doc.commands.get.responseVersions, [1, 2]);
    assert.equal(result.doc.commands.search.defaultResponseVersion, 1);
    assert.deepEqual(RESPONSE_VERSIONS.validate, [1]);
    assert.equal(result.doc.index.minReadableSchemaVersion, 1);
    assert.equal(result.doc.index.schemaVersion, SCHEMA_VERSION);
  });
});

describe('schema 1 database', () => {
  const searchRequest: SearchRequest = { profile: 'master', query: '결제 승인', scope: LINKED_SCOPE };
  const getRequest: GetRequest = { id: CANCEL_ID, profile: 'master', scope: LINKED_SCOPE };
  const verifyRequest = { profile: 'master', scope: LINKED_SCOPE, references: [{ indexId: null, indexGeneration: 1, itemId: CANCEL_ID, itemSha256: 'a'.repeat(64) }] };

  function assertUpgradeRequired(error: KnowledgeError): void {
    assert.deepEqual(error.detail, { reason: 'schema-upgrade-required', version: 1, required: SCHEMA_VERSION });
  }

  it('downgrades to the exact schema 1 layout', (t) => {
    const fixture = corpus(t);
    downgradeToSchema1(fixture.dbPath);
    assert.equal(userVersion(fixture.dbPath), 1);
    for (const table of ['item_segments', 'segments_fts', 'generation_leases']) assert.equal(tablesOf(fixture.dbPath).includes(table), false, table);
    assert.equal(columnsOf(fixture.dbPath, 'items').some((column) => ['token_count', 'operations_json', 'declaration_json'].includes(column)), false);
    assert.equal(columnsOf(fixture.dbPath, 'generations').includes('activated'), false);
    assert.deepEqual(columnsOf(fixture.dbPath, 'generation_sources'), sorted(['generation', 'source_id', 'project_id', 'requested_ref', 'commit_sha', 'document_count', 'skipped_json']));
    assert.equal(metaIndexId(fixture.dbPath), null);
  });

  it('serves v1 byte-identically, refuses v2 features without migrating, and upgrades on index', (t) => {
    const fixture = corpus(t);
    const { context, dbPath } = fixture;
    const searchBefore = JSON.stringify(search(context, searchRequest));
    const getBefore = JSON.stringify(getItem(context, getRequest));
    downgradeToSchema1(dbPath);

    assert.equal(JSON.stringify(search(context, searchRequest)), searchBefore);
    assert.equal(JSON.stringify(getItem(context, getRequest)), getBefore);
    for (const [name, request] of DEFAULT_REQUESTS) assert.equal(search(context, request).schemaVersion, 1, name);

    const kb = openKnowledgeBase({ dbPath });
    assertUpgradeRequired(failure(() => searchV2(context, asV2(searchRequest)), 'index-missing'));
    assertUpgradeRequired(failure(() => kb.searchV2(asV2(searchRequest)), 'index-missing'));
    assertUpgradeRequired(failure(() => getItemV2(context, { ...getRequest, responseVersion: 2 }), 'index-missing'));
    assertUpgradeRequired(failure(() => verifyReferences(context, verifyRequest), 'index-missing'));
    assertUpgradeRequired(failure(() => kb.verify(verifyRequest), 'index-missing'));
    assertUpgradeRequired(failure(() => kb.leases.list(), 'index-missing'));
    assertUpgradeRequired(failure(() => kb.leases.acquire({ holder: 'agent' }), 'index-missing'));
    assertUpgradeRequired(failure(() => kb.leases.acquire({ holder: 'agent', generation: 1 }), 'index-missing'));
    assertUpgradeRequired(failure(() => kb.leases.renew('00000000-0000-4000-8000-000000000000'), 'index-missing'));
    assertUpgradeRequired(failure(() => kb.leases.release('00000000-0000-4000-8000-000000000000'), 'index-missing'));
    // 임대·v2 조회는 되돌릴 수 없는 마이그레이션을 일으키면 안 된다
    assert.equal(userVersion(dbPath), 1);
    assert.equal(metaIndexId(dbPath), null);
    assert.equal(tablesOf(dbPath).includes('generation_leases'), false);
    assert.equal(JSON.stringify(search(context, searchRequest)), searchBefore);

    const indexed = fixture.index();
    assert.equal(indexed.status, 'unchanged');
    assert.equal(indexed.generation, 1);
    assert.equal(userVersion(dbPath), SCHEMA_VERSION);
    const indexId = metaIndexId(dbPath);
    assert.match(indexId ?? '', HEX32);

    assert.equal(JSON.stringify(search(context, searchRequest)), searchBefore);
    assert.equal(JSON.stringify(getItem(context, getRequest)), getBefore);
    const v2 = searchV2(context, asV2(searchRequest));
    assert.equal(v2.index.indexId, indexId);
    assert.ok(v2.items.length > 0);
    for (const item of v2.items) {
      assert.equal(item.ref.indexId, indexId);
      // 마이그레이션 전에 넣은 행은 HTTP 작업과 상태 표기 기록이 없다
      assert.equal(item.operations, null);
      assert.equal(item.knowledge.declaration, null);
    }
    assert.ok(searchV2(context, { ...asV2(searchRequest), ranker: 'bm25' }).items.length > 0);
    assert.equal(getItemV2(context, { ...getRequest, responseVersion: 2 }).item.id, CANCEL_ID);
    const lease = kb.leases.acquire({ holder: 'agent' });
    assert.equal(lease.generation, 1);
    assert.deepEqual(kb.leases.list().map((entry) => entry.leaseId), [lease.leaseId]);
  });

  it('keeps v1 output of a pre-upgrade generation byte-identical after migration', (t) => {
    const fixture = corpus(t);
    const { context, dbPath } = fixture;
    downgradeToSchema1(dbPath, true);
    const pinned: SearchRequest = { ...searchRequest, version: { generation: 1 } };
    const oldSearch = JSON.stringify(search(context, searchRequest));
    const oldGet = JSON.stringify(getItem(context, { ...getRequest, version: { generation: 1 } }));
    assert.equal(JSON.parse(oldSearch).index.parserVersion, 'md-1');

    const indexed = fixture.index();
    assert.equal(indexed.status, 'published');
    assert.equal(indexed.generation, 2);
    assert.equal(userVersion(dbPath), SCHEMA_VERSION);

    assert.equal(JSON.stringify(search(context, pinned)), oldSearch);
    assert.equal(JSON.stringify(getItem(context, { ...getRequest, version: { generation: 1 } })), oldGet);

    const old = searchV2(context, { ...asV2(pinned), segments: true });
    assert.ok(old.limitations.some((limitation) => limitation.code === 'generation-predates-v2'));
    assert.equal(old.retrieval.segments.requested, true);
    assert.equal(old.retrieval.segments.effective, false);
    assert.ok(old.items.every((item) => item.operations === null && item.segment === null));
    assert.equal(old.index.generation, 1);
    assert.deepEqual(old.index.sources.map((source) => source.refOrigin), [null, null]);

    const fresh = searchV2(context, asV2(searchRequest));
    assert.equal(fresh.index.generation, 2);
    assert.equal(fresh.limitations.some((limitation) => limitation.code === 'generation-predates-v2'), false);
    assert.ok(fresh.items.every((item) => Array.isArray(item.operations)));
    assert.deepEqual(fresh.index.sources.map((source) => source.refOrigin), ['config', 'config']);
  });

  it('answers the CLI the same way', (t) => {
    const space = tempSpace(t);
    const state = buildWorkspace(space);
    assert.equal(run(['index', '--config', state.config]).status, 0);
    downgradeToSchema1(state.dbPath);
    const db = ['--config', state.config];

    const status = run(['status', ...db]);
    assert.equal(status.status, 0, status.stdout);
    assert.deepEqual(keysOf(status.doc), sorted(STATUS_V1_KEYS));
    assert.equal(status.doc.schemaVersion, 1);
    assert.equal(run(['status', ...db, '--response-version', '1']).stdout, status.stdout);
    assert.equal(run(searchArgs(state.config)).status, 0);
    assert.equal(run(['get', ...db, '--id', POLICY_ID, '--profile', 'master', '--project', 'orders']).status, 0);

    const verifyFile = space.path('verify.json');
    writeFileSync(verifyFile, JSON.stringify(verifyRequest));
    for (const args of [
      ['status', ...db, '--response-version', '2'],
      ['lease', 'list', ...db],
      ['lease', 'acquire', ...db, '--holder', 'agent'],
      ['lease', 'renew', ...db, '--lease-id', 'x'],
      ['lease', 'release', ...db, '--lease-id', 'x'],
      searchArgs(state.config, ['--query', '결제', '--response-version', '2']),
      ['get', ...db, '--id', POLICY_ID, '--profile', 'master', '--project', 'orders', '--response-version', '2'],
      ['verify', ...db, '--request', verifyFile],
    ]) {
      const result = run(args);
      assertCliFailure(result, 'index-missing', 'schema-upgrade-required');
      assert.equal(result.doc.error.detail.version, 1, args.join(' '));
      assert.equal(result.doc.error.detail.required, SCHEMA_VERSION);
    }
    assert.equal(userVersion(state.dbPath), 1);
    assert.equal(metaIndexId(state.dbPath), null);
    assert.equal(run(['capabilities']).status, 0);

    const indexed = run(['index', ...db]);
    assert.equal(indexed.status, 0, indexed.stdout);
    assert.deepEqual(keysOf(indexed.doc), sorted(INDEX_V1_KEYS));
    assert.equal(userVersion(state.dbPath), SCHEMA_VERSION);
    const upgraded = run(['status', ...db, '--response-version', '2']);
    assert.equal(upgraded.status, 0, upgraded.stdout);
    assert.match(upgraded.doc.indexId, HEX32);
    assert.equal(upgraded.doc.databaseSchemaVersion, SCHEMA_VERSION);
    assert.equal(run(searchArgs(state.config, ['--query', '결제', '--response-version', '2'])).doc.schemaVersion, 2);
  });
});

describe('status and index output keys', () => {
  it('keeps v1 index keys for published, unchanged and --no-activate runs and adds v2 keys only on request', (t) => {
    const { config, orders } = buildWorkspace(tempSpace(t));
    const assertV1 = (result: Run, status: string): void => {
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.doc.schemaVersion, 1);
      assert.equal(result.doc.status, status);
      assert.deepEqual(keysOf(result.doc), sorted(INDEX_V1_KEYS));
      for (const source of result.doc.sources) assert.deepEqual(keysOf(source), sorted(INDEX_SOURCE_V1_KEYS));
      assertNoV2Keys(result.doc, 'index v1');
    };

    assertV1(run(['index', '--config', config]), 'published');
    assertV1(run(['index', '--config', config]), 'unchanged');
    assertV1(run(['index', '--config', config, '--response-version', '1']), 'unchanged');
    commit(orders, { 'docs/extra.md': '# 추가 문서\n\n추가 본문이다.\n' });
    const inactive = run(['index', '--config', config, '--no-activate']);
    assertV1(inactive, 'published');
    assert.equal(inactive.doc.generation, 2);
    assertV1(run(['index', '--config', config, '--no-activate']), 'unchanged');

    const assertV2 = (result: Run): void => {
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.doc.schemaVersion, 2);
      assert.deepEqual(keysOf(result.doc), sorted([...INDEX_V1_KEYS, ...INDEX_V2_EXTRA]));
      for (const source of result.doc.sources) {
        assert.deepEqual(keysOf(source), sorted([...INDEX_SOURCE_V1_KEYS, 'refOrigin', 'configSha256']));
        assert.match(source.configSha256, /^[0-9a-f]{64}$/);
      }
      assert.match(result.doc.indexId, HEX32);
      assert.equal(typeof result.doc.fingerprint, 'string');
    };
    const unchangedInactive = run(['index', '--config', config, '--no-activate', '--response-version', '2']);
    assertV2(unchangedInactive);
    assert.equal(unchangedInactive.doc.status, 'unchanged');
    assert.equal(unchangedInactive.doc.generation, 2);
    assert.equal(unchangedInactive.doc.activated, false);
    assert.equal(unchangedInactive.doc.activeGeneration, 1);
    assert.equal(unchangedInactive.doc.lease, null);

    const activated = run(['index', '--config', config, '--response-version', '2', '--lease-holder', 'agent', '--lease-ttl', '3600']);
    assertV2(activated);
    assert.equal(activated.doc.activated, true);
    assert.equal(activated.doc.activeGeneration, activated.doc.generation);
    assert.equal(activated.doc.lease.generation, activated.doc.generation);
    assert.equal(activated.doc.lease.holder, 'agent');
    assert.deepEqual(activated.doc.sources.map((source: { refOrigin: string }) => source.refOrigin), ['config', 'config']);

    const override = run(['index', '--config', config, '--response-version', '2', '--ref', 'orders=HEAD']);
    assertV2(override);
    assert.deepEqual(override.doc.sources.map((source: { sourceId: string; refOrigin: string }) => [source.sourceId, source.refOrigin]), [['billing', 'config'], ['orders', 'override']]);
  });

  it('keeps v1 status keys with leases and inactive generations and adds v2 keys only on request', (t) => {
    const { config, orders } = buildWorkspace(tempSpace(t));
    assert.equal(run(['index', '--config', config]).status, 0);
    commit(orders, { 'docs/extra.md': '# 추가 문서\n\n추가 본문이다.\n' });
    assert.equal(run(['index', '--config', config, '--no-activate']).status, 0);
    assert.equal(run(['lease', 'acquire', '--config', config, '--holder', 'agent', '--generation', '2']).status, 0);

    for (const extra of [[], ['--response-version', '1']]) {
      const status = run(['status', '--config', config, ...extra]);
      assert.equal(status.status, 0, status.stdout);
      assert.equal(status.doc.schemaVersion, 1);
      assert.deepEqual(keysOf(status.doc), sorted(STATUS_V1_KEYS));
      for (const source of status.doc.sources) assert.deepEqual(keysOf(source), sorted(STATUS_SOURCE_KEYS));
      for (const retained of status.doc.retainedGenerations) assert.deepEqual(keysOf(retained), sorted(RETAINED_KEYS));
      for (const entry of status.doc.runs) assert.deepEqual(keysOf(entry), sorted(RUN_KEYS));
      assert.deepEqual(keysOf(status.doc.counts), ['byKind', 'byStatus']);
      assert.deepEqual(status.doc.vector, { implemented: false, state: 'not-implemented' });
      assert.equal(status.doc.activeGeneration, 1);
      assertNoV2Keys(status.doc, 'status v1');
    }

    const v2 = run(['status', '--config', config, '--response-version', '2']);
    assert.equal(v2.status, 0, v2.stdout);
    assert.equal(v2.doc.schemaVersion, 2);
    assert.deepEqual(keysOf(v2.doc), sorted([...STATUS_V1_KEYS, ...STATUS_V2_EXTRA]));
    assert.match(v2.doc.indexId, HEX32);
    assert.equal(v2.doc.databaseSchemaVersion, SCHEMA_VERSION);
    for (const generation of v2.doc.generations) assert.deepEqual(keysOf(generation), sorted(['generation', 'activated', 'fingerprint', 'parserVersion', 'chunkerVersion', 'liveLeases']));
    assert.deepEqual(v2.doc.generations.map((entry: { generation: number; activated: boolean; liveLeases: number }) => [entry.generation, entry.activated, entry.liveLeases]), [[2, false, 1], [1, true, 0]]);
    assert.deepEqual(v2.doc.leases, { live: 1, expired: 0 });
  });

  it('refuses --lease-holder and --lease-ttl outside v2 without publishing', (t) => {
    const { config, orders, dbPath } = buildWorkspace(tempSpace(t));
    for (const args of [['--lease-holder', 'agent'], ['--lease-ttl', '3600'], ['--lease-holder', 'agent', '--response-version', '1']]) {
      assertCliFailure(run(['index', '--config', config, ...args]), 'usage');
      assert.equal(existsSync(dbPath), false, args.join(' '));
    }

    assert.equal(run(['index', '--config', config]).status, 0);
    commit(orders, { 'docs/extra.md': '# 추가 문서\n\n추가 본문이다.\n' });
    const before = run(['status', '--config', config, '--response-version', '2']).doc;
    for (const args of [['--lease-holder', 'agent'], ['--lease-holder', 'agent', '--lease-ttl', '3600'], ['--lease-ttl', '3600'], ['--lease-holder', 'agent', '--no-activate'], ['--response-version', '2', '--lease-ttl', '3600']]) {
      const result = run(['index', '--config', config, ...args]);
      assertCliFailure(result, 'usage');
      assert.equal(result.doc.command, 'index');
    }
    const afterwards = run(['status', '--config', config, '--response-version', '2']).doc;
    assert.deepEqual(afterwards.generations, before.generations);
    assert.deepEqual(afterwards.runs, before.runs);
    assert.deepEqual(afterwards.leases, { live: 0, expired: 0 });
    assert.equal(afterwards.activeGeneration, 1);
    assert.deepEqual(afterwards.sources.map((source: { upToDate: boolean }) => source.upToDate), [true, false]);
  });
});
