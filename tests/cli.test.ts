import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { EXIT_CODES, type ErrorCode } from '../src/index.js';
import { SCHEMA_VERSION } from '../src/indexing/schema.js';
import { commit, git, makeRepo, TempSpace, tempSpace } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const ORDERS_DOC = '---\nkind: policy\n---\n# 배송 정책\n\n배송 본문이다. 주문API를 호출한다.\n\n### `BR-001` 배송 기한\n\n- 코드: src/ship.ts\n\n기한 본문이다.\n';
const BILLING_DOC = '---\nkind: contract\n---\n# 정산 계약\n\n정산 본문이다.\n';
const ORDER_ID = 'orders:docs/a.md#배송-정책';
const BILLING_ID = 'billing:docs/b.md#정산-계약';

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  doc: Record<string, any>;
}

interface RunOptions {
  input?: string;
  env?: Record<string, string>;
}

function spawnCli(args: readonly string[], options: RunOptions = {}): Omit<Run, 'doc'> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_KNOWLEDGE_')));
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, input: options.input, env: { ...env, ...options.env } });
  assert.equal(result.error, undefined);
  return { status: result.status!, stdout: result.stdout, stderr: result.stderr };
}

/** 성공과 실패를 가리지 않고 stdout 전체가 JSON 문서 하나여야 한다. */
function run(args: readonly string[], options: RunOptions = {}): Run {
  const result = spawnCli(args, options);
  assert.equal(result.stdout.endsWith('\n'), true, `stdout must end with a newline: ${result.stdout}`);
  assert.equal(result.stdout.trimEnd().includes('\n'), false, `expected one line: ${result.stdout}`);
  return { ...result, doc: JSON.parse(result.stdout) as Record<string, any> };
}

interface Workspace {
  space: TempSpace;
  config: string;
  dbPath: string;
  orders: string;
  billing: string;
}

function writeConfig(path: string, sources: object[], database = './k.sqlite'): void {
  writeFileSync(path, stringify({ schemaVersion: 1, database: { path: database }, sources }));
}

function buildWorkspace(space: TempSpace): Workspace {
  const orders = makeRepo(space.path('orders'), { 'docs/a.md': ORDERS_DOC, 'src/ship.ts': '// fixture\n' });
  const billing = makeRepo(space.path('billing'), { 'docs/b.md': BILLING_DOC });
  const config = space.path('sources.yaml');
  writeConfig(config, [
    { id: 'orders', project: 'orders', path: orders, include: ['docs/**/*.md'] },
    { id: 'billing', project: 'billing', path: billing, include: ['docs/**/*.md'] },
  ]);
  return { space, config, dbPath: space.path('k.sqlite'), orders, billing };
}

function workspace(t: TestContext): Workspace {
  return buildWorkspace(tempSpace(t));
}

function assertFailure(result: Run, code: ErrorCode, command: string | null = result.doc.command as string | null): void {
  assert.equal(result.doc.schema, 'agent-knowledge.error', result.stdout);
  assert.equal(result.doc.schemaVersion, 1);
  assert.equal(result.doc.ok, false);
  assert.equal(result.doc.status, 'error');
  assert.equal(result.doc.command, command);
  assert.equal(result.doc.error.code, code, result.stdout);
  assert.equal(typeof result.doc.error.message, 'string');
  assert.notEqual(result.doc.error.detail, undefined);
  assert.equal(result.status, EXIT_CODES[code], result.stdout);
}

function searchArgs(config: string, extra: readonly string[] = ['--query', '배송']): string[] {
  return ['search', '--config', config, '--profile', 'master', '--project', 'orders', ...extra];
}

describe('full CLI flow', () => {
  it('runs validate → index → search → get → status → eval', (t) => {
    const { config, orders } = workspace(t);

    const validate = run(['validate', '--config', config]);
    assert.equal(validate.status, 0, validate.stdout);
    assert.equal(validate.doc.schema, 'agent-knowledge.validate');
    assert.equal(validate.doc.status, 'valid');
    assert.deepEqual(validate.doc.sources.map((source: { id: string }) => source.id), ['orders', 'billing']);
    assert.match(validate.stderr, /원본을 검사했습니다: orders/);

    const indexed = run(['index', '--config', config]);
    assert.equal(indexed.status, 0, indexed.stdout);
    assert.equal(indexed.doc.schema, 'agent-knowledge.index');
    assert.equal(indexed.doc.status, 'published');
    assert.equal(indexed.doc.generation, 1);
    assert.equal(indexed.doc.commits.orders, git(orders, ['rev-parse', 'HEAD']));
    assert.equal(indexed.doc.sources.find((source: { sourceId: string }) => source.sourceId === 'orders').added, 1);
    assert.match(indexed.stderr, /원본을 수집합니다: orders/);
    assert.doesNotMatch(indexed.stdout, /원본을 수집합니다/);

    const again = run(['index', '--config', config]);
    assert.equal(again.status, 0);
    assert.equal(again.doc.status, 'unchanged');
    assert.equal(again.doc.generation, 1);

    const found = run(searchArgs(config));
    assert.equal(found.status, 0, found.stdout);
    assert.equal(found.doc.schema, 'agent-knowledge.search');
    assert.equal(found.doc.status, 'ok');
    assert.equal(found.doc.index.generation, 1);
    const item = found.doc.items.find((candidate: { id: string }) => candidate.id === ORDER_ID);
    assert.equal(item.provenance.path, 'docs/a.md');
    assert.equal(item.provenance.startLine, 4);
    assert.equal(item.provenance.commit, git(orders, ['rev-parse', 'HEAD']));

    const got = run(['get', '--config', config, '--id', ORDER_ID, '--profile', 'master', '--project', 'orders']);
    assert.equal(got.status, 0, got.stdout);
    assert.equal(got.doc.schema, 'agent-knowledge.get');
    assert.equal(got.doc.item.id, ORDER_ID);
    assert.match(got.doc.item.content, /^# 배송 정책/);

    const status = run(['status', '--config', config]);
    assert.equal(status.status, 0, status.stdout);
    assert.equal(status.doc.schema, 'agent-knowledge.status');
    assert.equal(status.doc.activeGeneration, 1);
    assert.deepEqual(status.doc.retainedGenerations.map((entry: { generation: number }) => entry.generation), [1]);
    assert.deepEqual(status.doc.sources.map((source: { sourceId: string; upToDate: boolean }) => [source.sourceId, source.upToDate]), [['billing', true], ['orders', true]]);
    assert.equal(status.doc.counts.byKind.policy, 2);
    assert.equal(status.doc.counts.byStatus.unverified, 3);
    assert.equal(status.doc.runs.length, 2);
    assert.equal(status.doc.lastFailure, null);
    assert.equal(status.doc.vector.implemented, false);
    assert.ok(Array.isArray(status.doc.diagnostics));

    commit(orders, { 'docs/a.md': `${ORDERS_DOC}\n추가 문장이다.\n` });
    assert.deepEqual(run(['status', '--config', config]).doc.sources.map((source: { upToDate: boolean }) => source.upToDate), [true, false]);

    const evaluated = run(['eval']);
    assert.equal(evaluated.status, 0, evaluated.stdout);
    assert.equal(evaluated.doc.schema, 'agent-knowledge.eval');
    assert.equal(evaluated.doc.ok, true);
    assert.equal(evaluated.doc.status, 'passed');
    assert.ok(evaluated.doc.summary.casesTotal >= 20);
    assert.equal(evaluated.doc.summary.casesPassed, evaluated.doc.summary.casesTotal);
    assert.equal(evaluated.doc.summary.recallAtK, 1);
    assert.equal(typeof evaluated.doc.summary.mrr, 'number');
    assert.deepEqual(evaluated.doc.suites.map((suite: { suite: string }) => suite.suite).sort(), ['code-sample', 'master-sample']);
    for (const suite of evaluated.doc.suites) assert.equal(suite.metrics.casesPassed, suite.metrics.casesTotal);
  });
});

describe('outcomes', () => {
  let workspaceState: Workspace;
  let config: string;

  before(() => {
    workspaceState = buildWorkspace(new TempSpace());
    config = workspaceState.config;
    const indexed = run(['index', '--config', config]);
    assert.equal(indexed.status, 0, indexed.stdout);
  });

  after(() => workspaceState.space.dispose());

  const garbageDb = (name: string): string => {
    const path = workspaceState.space.path(name);
    writeFileSync(path, 'this is definitely not a sqlite database, only some plain text that is long enough');
    return path;
  };
  const missingDb = (name: string): string => workspaceState.space.path(name);

  it('reports no-results as a distinct success with exit 3', () => {
    const result = run(searchArgs(config, ['--query', '없는단어입니다']));
    assert.equal(result.doc.schema, 'agent-knowledge.search');
    assert.equal(result.doc.ok, true);
    assert.equal(result.doc.status, 'no-results');
    assert.deepEqual(result.doc.items, []);
    assert.equal(result.status, 3);
  });

  it('reports not-found with its own code', () => {
    assertFailure(run(['get', '--config', config, '--id', 'orders:docs/none.md#x', '--profile', 'master', '--project', 'orders']), 'not-found', 'get');
  });

  it('reports invalid-scope for an unknown project', () => {
    assertFailure(run(['search', '--config', config, '--profile', 'master', '--project', 'nobody', '--query', '배송']), 'invalid-scope', 'search');
  });

  it('reports invalid-scope when code gets two projects', () => {
    assertFailure(run(['search', '--config', config, '--profile', 'code', '--project', 'orders', '--project', 'billing', '--query', '배송']), 'invalid-scope', 'search');
  });

  it('reports index-missing without a database', () => {
    const result = run([...searchArgs(config), '--db', missingDb('absent.sqlite')]);
    assertFailure(result, 'index-missing', 'search');
    assert.equal(result.doc.error.detail.reason, 'no-database');
  });

  it('reports index-missing for a missing generation', () => {
    const result = run(searchArgs(config, ['--query', '배송', '--generation', '99']));
    assertFailure(result, 'index-missing', 'search');
    assert.equal(result.doc.error.detail.reason, 'generation-not-found');
  });

  it('reports index-missing from status without a database', () => {
    const result = run(['status', '--config', config, '--db', missingDb('absent2.sqlite')]);
    assertFailure(result, 'index-missing', 'status');
    assert.equal(result.doc.error.detail.reason, 'no-database');
  });

  it('reports store-unavailable for a garbage database', () => {
    assertFailure(run([...searchArgs(config), '--db', garbageDb('garbage.sqlite')]), 'store-unavailable', 'search');
  });

  it('reports store-unavailable from status and index for a garbage database', () => {
    assertFailure(run(['status', '--config', config, '--db', garbageDb('garbage2.sqlite')]), 'store-unavailable', 'status');
    assertFailure(run(['index', '--config', config, '--db', garbageDb('garbage3.sqlite')]), 'store-unavailable', 'index');
  });

  it('reports config-invalid for a missing config without a database', () => {
    const result = run(searchArgs(workspaceState.space.path('absent.yaml')));
    assertFailure(result, 'config-invalid', 'search');
    assert.equal(result.doc.error.detail.reason, 'not-found');
  });

  it('reports config-invalid for a malformed config', () => {
    const path = workspaceState.space.path('bad.yaml');
    writeFileSync(path, 'schemaVersion: 2\n');
    assertFailure(run(['index', '--config', path]), 'config-invalid', 'index');
    assertFailure(run(['validate', '--config', path]), 'config-invalid', 'validate');
  });

  it('reports config-invalid for a bad retrieval config', () => {
    const path = workspaceState.space.path('bad-retrieval.yaml');
    writeFileSync(path, 'schemaVersion: 1\n');
    assertFailure(run([...searchArgs(config), '--retrieval-config', path]), 'config-invalid', 'search');
  });

  it('reports invalid-request for an unsearchable query', () => {
    const result = run(searchArgs(config, ['--query', '!!!']));
    assertFailure(result, 'invalid-request', 'search');
    assert.equal(result.doc.error.detail.reason, 'no-searchable-terms');
  });

  it('reports invalid-request for an unusable request file', () => {
    const missing = run(['search', '--config', config, '--request', workspaceState.space.path('none.json')]);
    assertFailure(missing, 'invalid-request', 'search');
    assert.equal(missing.doc.error.detail.reason, 'request-unreadable');

    const notJson = workspaceState.space.path('request.txt');
    writeFileSync(notJson, 'not json');
    const invalid = run(['search', '--config', config, '--request', notJson]);
    assertFailure(invalid, 'invalid-request', 'search');
    assert.equal(invalid.doc.error.detail.reason, 'request-not-json');

    assertFailure(run(['search', '--config', config, '--request', '-'], { input: '{"profile":"nope"}' }), 'invalid-request', 'search');
  });

  it('reports usage errors as JSON with exit 2', () => {
    assertFailure(run([]), 'usage', null);
    assertFailure(run(['bogus']), 'usage', null);
    assertFailure(run(['search', '--bogus']), 'usage', 'search');
    assertFailure(run(['search', '--config', config, '--project', 'orders', '--query', '배송']), 'usage', 'search');
    assertFailure(run(['search', '--config', config, '--profile', 'master', '--project', 'orders']), 'usage', 'search');
    assertFailure(run(['search', '--config', config, '--profile', 'master', '--query', '배송']), 'usage', 'search');
    assertFailure(run(searchArgs(config, ['--query', '배송', '--limit', 'many'])), 'usage', 'search');
    assertFailure(run(searchArgs(config, ['--query', '배송', '--commit', 'orders'])), 'usage', 'search');
    assertFailure(run(searchArgs(config, ['--query', '배송', '--request', '-'])), 'usage', 'search');
    assertFailure(run(['index', '--config', config, '--ref', 'orders']), 'usage', 'index');
    assertFailure(run(['get', '--config', config, '--profile', 'master', '--project', 'orders']), 'usage', 'get');
  });

  it('applies --pretty to failures', () => {
    const result = spawnCli(['bogus', '--pretty']);
    assert.ok(result.stdout.trimEnd().includes('\n'));
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, 'usage');
  });

  it('reports source-unavailable for a bad ref override', () => {
    const result = run(['index', '--config', config, '--ref', 'orders=no-such-ref']);
    assertFailure(result, 'source-unavailable', 'index');
  });

  it('reports source-unavailable for an unknown ref source', () => {
    const result = run(['index', '--config', config, '--ref', 'nobody=HEAD']);
    assertFailure(result, 'source-unavailable', 'index');
    assert.equal(result.doc.error.detail.reason, 'unknown-source');
  });

  it('reports eval-failed for broken suites', () => {
    const invalid = workspaceState.space.path('invalid-suite.yaml');
    writeFileSync(invalid, 'schemaVersion: 1\nsuite: x\n');
    assertFailure(run(['eval', '--suite', invalid]), 'eval-failed', 'eval');
    assertFailure(run(['eval', '--suite', workspaceState.space.path('no-such-suite')]), 'eval-failed', 'eval');

    const noWorkspaceDir = workspaceState.space.path('fixture-missing.yaml');
    writeFileSync(noWorkspaceDir, stringify({ schemaVersion: 1, suite: 'w', profile: 'code', workspace: './nope', cases: [{ id: 'A', query: 'x', scope: { projects: ['a'] }, expect: { status: 'ok' } }] }));
    const missing = run(['eval', '--suite', noWorkspaceDir]);
    assertFailure(missing, 'eval-failed', 'eval');
    assert.equal(missing.doc.error.detail.reason, 'workspace-failed');
  });
});

describe('failed indexing', () => {
  it('refuses an empty source list and keeps the published index', (t) => {
    const { config, space } = workspace(t);
    assert.equal(run(['index', '--config', config]).status, 0);
    const empty = space.path('empty.yaml');
    writeConfig(empty, []);
    assertFailure(run(['validate', '--config', empty]), 'config-invalid', 'validate');
    assertFailure(run(['index', '--config', empty]), 'config-invalid', 'index');
    assert.equal(run(searchArgs(config)).status, 0);
  });

  it('warns on stderr, even with --quiet, when a source matches no documents', (t) => {
    const { space, orders } = workspace(t);
    const typo = space.path('typo.yaml');
    writeConfig(typo, [{ id: 'orders', project: 'orders', path: orders, include: ['doc-typo/**/*.md'] }]);
    const result = run(['index', '--config', typo, '--quiet']);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.doc.documentCount, 0);
    assert.match(result.stderr, /^orders no-matching-documents/m);
  });

  it('reports a current-version database without the index tables as store-unavailable', (t) => {
    const { config, space } = workspace(t);
    const hollow = space.path('hollow.sqlite');
    const raw = new DatabaseSync(hollow);
    raw.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    raw.close();
    for (const args of [[...searchArgs(config), '--db', hollow], ['index', '--config', config, '--db', hollow], ['status', '--config', config, '--db', hollow]]) {
      const result = run(args);
      assertFailure(result, 'store-unavailable', args[0]!);
      assert.equal(result.doc.error.detail.reason, 'unknown-database', result.stdout);
    }
  });

  it('reports a __proto__ --commit key as an unknown source', (t) => {
    const { config } = workspace(t);
    assert.equal(run(['index', '--config', config]).status, 0);
    const result = run(searchArgs(config, ['--query', '배송', '--commit', '__proto__=deadbeef']));
    assertFailure(result, 'invalid-scope', 'search');
    assert.equal(result.doc.error.detail.reason, 'unknown-source', result.stdout);
  });

  it('exits non-zero and keeps the previous generation searchable', (t) => {
    const { config, orders, space } = workspace(t);
    assert.equal(run(['index', '--config', config]).status, 0);

    const broken = space.path('broken.yaml');
    writeConfig(broken, [{ id: 'orders', project: 'orders', path: space.path('gone'), include: ['docs/**/*.md'] }], join(space.root, 'k.sqlite'));
    const failed = run(['index', '--config', broken]);
    assert.notEqual(failed.status, 0);
    assertFailure(failed, 'source-unavailable', 'index');

    commit(orders, { 'docs/a.md': '# 배송 정책\n\n새로운 배송 본문이다.\n' });
    const result = run(searchArgs(config));
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.doc.index.generation, 1);
    assert.equal(result.doc.items.some((item: { excerpt: string }) => item.excerpt.includes('새로운')), false);

    const status = run(['status', '--config', config]);
    assert.equal(status.doc.lastFailure.errorCode, 'source-unavailable');
    assert.equal(status.doc.runs[0].status, 'failed');
  });

  it('aborts every source when one is unavailable', (t) => {
    const { config, billing, space } = workspace(t);
    rmSync(billing, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    const result = run(['index', '--config', config]);
    assertFailure(result, 'source-unavailable', 'index');
    assertFailure(run([...searchArgs(config), '--db', space.path('k.sqlite')]), 'index-missing', 'search');
  });
});

describe('validate reporting', () => {
  it('reports an invalid source in its own document with exit 7', (t) => {
    const { space, orders } = workspace(t);
    const path = space.path('partly.yaml');
    writeConfig(path, [
      { id: 'orders', project: 'orders', path: orders, include: ['docs/**/*.md'] },
      { id: 'gone', project: 'gone', path: space.path('missing'), include: ['docs/**/*.md'] },
    ]);
    const result = run(['validate', '--config', path]);
    assert.equal(result.status, EXIT_CODES['config-invalid']);
    assert.equal(result.doc.schema, 'agent-knowledge.validate');
    assert.equal(result.doc.ok, false);
    assert.equal(result.doc.status, 'invalid');
    assert.equal(result.doc.error.code, 'config-invalid');
    const byId = new Map(result.doc.sources.map((source: { id: string }) => [source.id, source])) as Map<string, { ok: boolean; errors: { code: string }[] }>;
    assert.equal(byId.get('orders')!.ok, true);
    assert.deepEqual(byId.get('gone')!.errors.map((issue) => issue.code), ['path-not-found']);
  });

  it('fails on an invalid retrieval config while still reporting sources', (t) => {
    const { space, config } = workspace(t);
    const path = space.path('bad-retrieval.yaml');
    writeFileSync(path, 'schemaVersion: 1\n');
    const result = run(['validate', '--config', config, '--retrieval-config', path]);
    assert.equal(result.status, EXIT_CODES['config-invalid']);
    assert.equal(result.doc.retrieval.ok, false);
    assert.equal(result.doc.retrieval.error.code, 'config-invalid');
    assert.equal(result.doc.sources.length, 2);
  });

  it('treats warnings as success', (t) => {
    const { space, orders } = workspace(t);
    const path = space.path('warn.yaml');
    writeConfig(path, [{ id: 'orders', project: 'orders', path: orders, include: ['nothing/**/*.md'] }]);
    const result = run(['validate', '--config', path]);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.doc.sources[0].warnings.map((warning: { code: string }) => warning.code), ['no-matching-documents']);
    assert.match(result.stderr, /no-matching-documents/);
  });

  it('warns about dirty tracked documents without failing', (t) => {
    const { config, orders } = workspace(t);
    writeFileSync(join(orders, 'docs', 'a.md'), `${ORDERS_DOC}\n커밋되지 않은 줄이다.\n`);
    const result = run(['validate', '--config', config]);
    assert.equal(result.status, 0, result.stdout);
    assert.ok(result.doc.sources.find((source: { id: string }) => source.id === 'orders').warnings.some((warning: { code: string }) => warning.code === 'dirty-tracked-documents'));
  });
});

describe('arguments', () => {
  let state: Workspace;

  before(() => {
    state = buildWorkspace(new TempSpace());
    assert.equal(run(['index', '--config', state.config]).status, 0);
  });

  after(() => state.space.dispose());

  it('round-trips Korean argv and output as UTF-8', () => {
    const result = run(searchArgs(state.config, ['--query', '배송 정책을']));
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.doc.request.query, '배송 정책을');
    assert.ok(result.doc.items.some((item: { id: string; title: string }) => item.id === ORDER_ID && item.title === '배송 정책'));

    const got = run(['get', '--config', state.config, '--id', ORDER_ID, '--profile', 'master', '--project', 'orders']);
    assert.equal(got.status, 0, got.stdout);
    assert.equal(got.doc.item.id, ORDER_ID);
    assert.deepEqual(got.doc.item.headingPath, ['배송 정책']);
  });

  it('round-trips a Korean request through stdin', () => {
    const request = JSON.stringify({ profile: 'master', query: '배송 정책', scope: { projects: ['orders'] } });
    const result = run(['search', '--config', state.config, '--request', '-'], { input: request });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.doc.request.query, '배송 정책');
  });

  it('accepts a request file with a BOM', () => {
    const path = state.space.path('request.json');
    writeFileSync(path, `﻿${JSON.stringify({ profile: 'master', query: '기한', scope: { projects: ['orders'] } })}`);
    const result = run(['search', '--config', state.config, '--request', path]);
    assert.equal(result.status, 0, result.stdout);
    assert.ok(result.doc.items.some((item: { key: string }) => item.key === 'BR-001'));
  });

  it('accepts a get request file', () => {
    const path = state.space.path('get.json');
    writeFileSync(path, JSON.stringify({ id: ORDER_ID, profile: 'master', scope: { projects: ['orders'] } }));
    const result = run(['get', '--config', state.config, '--request', path]);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.doc.item.id, ORDER_ID);
    assertFailure(run(['get', '--config', state.config, '--request', path, '--id', ORDER_ID]), 'usage', 'get');
  });

  it('applies scope, filter, version and task flags', () => {
    const scoped = run(['search', '--config', state.config, '--profile', 'master', '--project', 'orders', '--allow-link', 'billing:contract', '--query', '정산']);
    assert.equal(scoped.status, 0, scoped.stdout);
    assert.deepEqual(scoped.doc.appliedScope.allowedLinks, [{ project: 'billing', kinds: ['contract'], itemIds: null }]);
    assert.ok(scoped.doc.items.some((item: { id: string }) => item.id === BILLING_ID));

    const filtered = run(searchArgs(state.config, ['--query', '배송', '--kind', 'policy', '--status', 'unverified', '--limit', '1', '--phase', 'implement']));
    assert.equal(filtered.status, 0, filtered.stdout);
    assert.deepEqual(filtered.doc.appliedScope.kinds, ['policy']);
    assert.deepEqual(filtered.doc.appliedScope.statuses, ['unverified']);
    assert.equal(filtered.doc.request.limit, 1);
    assert.equal(filtered.doc.request.task.phase, 'implement');

    const commitSha = git(state.orders, ['rev-parse', 'HEAD']);
    const pinned = run(searchArgs(state.config, ['--query', '배송', '--generation', '1', '--commit', `orders=${commitSha.slice(0, 8)}`]));
    assert.equal(pinned.status, 0, pinned.stdout);
    assert.equal(pinned.doc.index.generation, 1);

    const byPath = run(['search', '--config', state.config, '--profile', 'code', '--project', 'orders', '--path', 'src\\ship.ts']);
    assert.equal(byPath.status, 0, byPath.stdout);
    assert.ok(byPath.doc.items.some((item: { key: string }) => item.key === 'BR-001'));
    assert.ok(byPath.doc.codeLocations.some((location: { path: string; commit: string }) => location.path === 'src/ship.ts' && location.commit === commitSha));
  });

  it('does not expose other projects without an allowed link', () => {
    const result = run(searchArgs(state.config, ['--query', '정산']));
    assert.doesNotMatch(result.stdout, /billing/);
    assert.equal(result.doc.status, 'no-results');
    assert.equal(result.status, 3);
  });

  it('prints help as plain text with exit 0', () => {
    for (const args of [['help'], ['--help'], ['-h'], ['search', '--help']]) {
      const result = spawnCli(args);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^agent-knowledge <명령>/);
      assert.throws(() => JSON.parse(result.stdout));
    }
  });

  it('writes one line by default and indents with --pretty', () => {
    const compact = spawnCli(searchArgs(state.config));
    const pretty = spawnCli([...searchArgs(state.config), '--pretty']);
    assert.equal(compact.stdout.trimEnd().includes('\n'), false);
    assert.ok(pretty.stdout.trimEnd().split('\n').length > 1);
    assert.deepEqual(JSON.parse(pretty.stdout), JSON.parse(compact.stdout));
  });

  it('is byte-identical across repeated searches', () => {
    assert.equal(spawnCli(searchArgs(state.config)).stdout, spawnCli(searchArgs(state.config)).stdout);
  });

  it('silences progress with --quiet without changing stdout', (t) => {
    const { config } = workspace(t);
    const quiet = run(['index', '--config', config, '--quiet']);
    assert.equal(quiet.status, 0, quiet.stdout);
    assert.equal(quiet.doc.status, 'published');
    assert.doesNotMatch(quiet.stderr, /원본을 수집합니다/);
    assert.equal(run(['validate', '--config', config, '--quiet']).stderr.includes('원본을 검사했습니다'), false);
  });

  it('reports document diagnostics on stderr and in status, even with --quiet', (t) => {
    const { config, orders } = workspace(t);
    commit(orders, { 'docs/a.md': '# 배송 정책\n\n- 상태: 확정 예정\n\n본문이다.\n' });
    const indexed = run(['index', '--config', config, '--quiet']);
    assert.equal(indexed.status, 0, indexed.stdout);
    assert.match(indexed.stderr, /orders:docs\/a\.md unknown-status-value/);
    assert.doesNotMatch(indexed.stderr, /원본을 수집합니다/);

    const status = run(['status', '--config', config]);
    assert.deepEqual(status.doc.diagnostics, [{ sourceId: 'orders', path: 'docs/a.md', code: 'unknown-status-value', message: '확정 예정' }]);
    assert.equal(status.doc.diagnosticsTotal, 1);
  });

  it('reads paths from the environment', () => {
    const env = { AGENT_KNOWLEDGE_CONFIG: state.config };
    assert.equal(run(['search', '--profile', 'master', '--project', 'orders', '--query', '배송'], { env }).status, 0);

    const db = state.space.path('k.sqlite');
    const viaDb = run(['status', '--config', state.space.path('none.yaml')], { env: { AGENT_KNOWLEDGE_DB: db } });
    assert.equal(viaDb.status, 0, viaDb.stdout);

    const badRetrieval = state.space.path('bad-env-retrieval.yaml');
    writeFileSync(badRetrieval, 'schemaVersion: 1\n');
    assertFailure(run(['search', '--profile', 'master', '--project', 'orders', '--query', '배송'], { env: { ...env, AGENT_KNOWLEDGE_RETRIEVAL_CONFIG: badRetrieval } }), 'config-invalid', 'search');
  });

  it('works with a database and no config, using the generation as the registry', () => {
    const db = state.space.path('k.sqlite');
    const absent = state.space.path('none.yaml');
    const found = run(['search', '--config', absent, '--db', db, '--profile', 'master', '--project', 'orders', '--query', '배송']);
    assert.equal(found.status, 0, found.stdout);
    assertFailure(run(['search', '--config', absent, '--db', db, '--profile', 'master', '--project', 'nobody', '--query', '배송']), 'invalid-scope', 'search');

    const status = run(['status', '--config', absent, '--db', db]);
    assert.equal(status.status, 0, status.stdout);
    assert.deepEqual(status.doc.sources.map((source: { upToDate: boolean | null }) => source.upToDate), [null, null]);
  });
});

describe('eval command', () => {
  function suiteFile(space: TempSpace, cases: object[], name = 'suite.yaml', extra: object = {}): string {
    const path = space.path(name);
    writeFileSync(path, stringify({ schemaVersion: 1, suite: 'temp', profile: 'master', ...extra, cases }));
    return path;
  }

  const FIXTURE = join(PACKAGE_ROOT, 'evals', 'fixtures', 'sample-workspace');

  it('exits 9 with a metrics document when a case fails', (t) => {
    const space = tempSpace(t);
    const path = suiteFile(
      space,
      [
        { id: 'miss', query: '결제 승인', scope: { projects: ['sample-orders'] }, expect: { items: ['sample-orders:docs/none.md#x'] } },
        { id: 'wrong-error', query: '결제', scope: { projects: ['sample-orders'] }, expect: { error: 'invalid-scope' } },
        { id: 'unexpected-error', query: '결제', scope: { projects: ['sample-unknown'] }, expect: { status: 'ok' } },
        { id: 'pass', query: '결제 승인 연동 인계', scope: { projects: ['sample-orders'] }, expect: { items: ['sample-orders:docs/handoff.md#결제-승인-연동-인계-사례'] } },
      ],
      'suite.yaml',
      { workspace: FIXTURE },
    );
    const result = run(['eval', '--suite', path]);
    assert.equal(result.status, EXIT_CODES['eval-failed'], result.stdout);
    assert.equal(result.doc.schema, 'agent-knowledge.eval');
    assert.equal(result.doc.ok, false);
    assert.equal(result.doc.status, 'failed');
    assert.equal(result.doc.error.code, 'eval-failed');
    assert.equal(result.doc.summary.casesTotal, 4);
    assert.equal(result.doc.summary.casesPassed, 1);
    assert.equal(result.doc.summary.recallAtK, 0.5);
    const failures = new Map(result.doc.suites[0].cases.map((entry: { id: string; failures: string[] }) => [entry.id, entry.failures[0] ?? '']));
    assert.match(failures.get('miss') as string, /^item-missing: /);
    assert.match(failures.get('wrong-error') as string, /^expected-error: invalid-scope, got ok/);
    assert.match(failures.get('unexpected-error') as string, /^unexpected-error: invalid-scope: /);
    assert.equal(failures.get('pass'), '');
    assert.match(result.stderr, /실패: temp\/miss/);
  });

  it('checks status, absent, sections, unconfirmed and locations', (t) => {
    const space = tempSpace(t);
    const path = suiteFile(
      space,
      [
        { id: 'status', query: '결제 승인', scope: { projects: ['sample-orders'] }, expect: { status: 'no-results' } },
        { id: 'absent', query: '배송비', scope: { projects: ['sample-orders'] }, expect: { absent: ['sample-orders:docs/business-rules.md#BR-005'] } },
        { id: 'section', query: '배송비', scope: { projects: ['sample-orders'] }, expect: { sections: { cases: ['sample-orders:docs/business-rules.md#BR-005'] } } },
        { id: 'confirmed', query: '결제 승인 연동 인계', scope: { projects: ['sample-orders'] }, expect: { unconfirmed: ['sample-orders:docs/handoff.md#결제-승인-연동-인계-사례'] } },
        { id: 'location', query: '결제 승인 연동 인계', scope: { projects: ['sample-orders'] }, expect: { locations: [{ path: 'docs/handoff.md', startLine: 1, endLine: 3, sourceId: 'sample-orders' }] } },
        { id: 'contained', query: '결제 승인 연동 인계', scope: { projects: ['sample-orders'] }, expect: { locations: [{ path: 'docs/handoff.md', startLine: 10, endLine: 12 }] } },
      ],
      'suite.yaml',
      { workspace: FIXTURE },
    );
    const result = run(['eval', '--suite', path]);
    assert.equal(result.status, EXIT_CODES['eval-failed'], result.stdout);
    const failures = new Map(result.doc.suites[0].cases.map((entry: { id: string; failures: string[] }) => [entry.id, entry.failures[0] ?? '']));
    assert.match(failures.get('status') as string, /^status-mismatch: /);
    assert.match(failures.get('absent') as string, /^unexpected-item: /);
    assert.match(failures.get('section') as string, /^section-missing: cases: /);
    assert.match(failures.get('confirmed') as string, /^unexpectedly-confirmed: /);
    assert.match(failures.get('location') as string, /^location-missing: /);
    assert.equal(failures.get('contained'), '');
  });

  it('runs a suite against the configured index when no workspace is given', (t) => {
    const { config, space } = workspace(t);
    assert.equal(run(['index', '--config', config]).status, 0);
    const path = suiteFile(space, [{ id: 'A', query: '주문API를', scope: { projects: ['orders'] }, expect: { status: 'ok', items: [ORDER_ID], absent: [BILLING_ID] } }]);
    const result = run(['eval', '--suite', path, '--config', config]);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.doc.summary.recallAtK, 1);
    assert.equal(result.doc.summary.mrr, 1);
  });

  it('runs every yaml in a suite directory only once', (t) => {
    const { config, space } = workspace(t);
    assert.equal(run(['index', '--config', config]).status, 0);
    mkdirSync(space.path('suites'));
    suiteFile(space, [{ id: 'A', query: '배송', scope: { projects: ['orders'] }, expect: { items: [ORDER_ID] } }], join('suites', 'a.yaml'), { suite: 'a' });
    suiteFile(space, [{ id: 'B', query: '배송', scope: { projects: ['orders'] }, expect: { items: [ORDER_ID] } }], join('suites', 'b.yml'), { suite: 'b' });
    const result = run(['eval', '--suite', space.path('suites'), '--suite', space.path('suites', 'a.yaml'), '--config', config]);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.doc.suites.map((suite: { suite: string }) => suite.suite), ['a', 'b']);
  });

  it('propagates a config problem for a suite without a workspace', (t) => {
    const space = tempSpace(t);
    const path = suiteFile(space, [{ id: 'A', query: '배송', scope: { projects: ['orders'] }, expect: { status: 'ok' } }]);
    assertFailure(run(['eval', '--suite', path, '--config', space.path('none.yaml')]), 'config-invalid', 'eval');
  });

  for (const [name, expectation] of Object.entries({
    empty: {},
    'empty lists': { items: [], locations: [], absent: [], unconfirmed: [] },
    'no sections': { sections: {} },
    'only empty sections': { sections: { cases: [] } },
  })) {
    it(`refuses a case that asserts nothing: ${name}`, (t) => {
      const space = tempSpace(t);
      const path = suiteFile(space, [{ id: 'A', query: '결제', scope: { projects: ['sample-orders'] }, expect: expectation }], 'suite.yaml', { workspace: FIXTURE });
      const result = run(['eval', '--suite', path]);
      assertFailure(result, 'eval-failed', 'eval');
      assert.equal(result.doc.error.detail.reason, 'suite-invalid', result.stdout);
    });
  }

  it('accepts a case whose only assertion is absent, unconfirmed or a section', (t) => {
    const space = tempSpace(t);
    const path = suiteFile(
      space,
      [
        { id: 'absent', query: '결제', scope: { projects: ['sample-orders'] }, expect: { absent: ['sample-orders:docs/none.md#x'] } },
        { id: 'unconfirmed', query: '결제 승인 연동 인계', scope: { projects: ['sample-orders'] }, expect: { unconfirmed: ['sample-orders:docs/handoff.md#결제-승인-연동-인계-사례'] } },
        { id: 'section', query: '배송비', scope: { projects: ['sample-orders'] }, expect: { sections: { cases: ['sample-orders:docs/business-rules.md#BR-005'] } } },
        { id: 'error', query: '결제', scope: { projects: ['sample-unknown'] }, expect: { error: 'invalid-scope' } },
      ],
      'suite.yaml',
      { workspace: FIXTURE },
    );
    const result = run(['eval', '--suite', path]);
    assert.equal(result.doc.schema, 'agent-knowledge.eval', result.stdout);
    assert.equal(result.doc.summary.casesTotal, 4);
  });

  it('refuses a suite with no cases', (t) => {
    const space = tempSpace(t);
    const result = run(['eval', '--suite', suiteFile(space, [], 'suite.yaml', { workspace: FIXTURE })]);
    assertFailure(result, 'eval-failed', 'eval');
    assert.equal(result.doc.error.detail.reason, 'suite-invalid', result.stdout);
  });

  it('removes its temporary fixture repositories', (t) => {
    const space = tempSpace(t);
    const env = { TMPDIR: space.root, TEMP: space.root, TMP: space.root };
    const path = suiteFile(space, [{ id: 'A', query: '결제', scope: { projects: ['sample-orders'] }, expect: { status: 'ok' } }], 'suite.yaml', { workspace: FIXTURE });
    assert.equal(run(['eval', '--suite', path], { env }).status, 0);
    assert.deepEqual(readdirNames(space.root), ['suite.yaml']);
  });
});

function readdirNames(path: string): string[] {
  const listing = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("node:fs").readdirSync(process.argv[1])))', path], { encoding: 'utf8', windowsHide: true });
  return JSON.parse(listing.stdout) as string[];
}

describe('runtime configuration files', () => {
  it('pins the Qdrant image and binds it to loopback', () => {
    const compose = parse(readFileSync(join(PACKAGE_ROOT, 'compose.yaml'), 'utf8')) as { services: { qdrant: { image: string; ports: string[]; volumes: string[]; restart: string } }; volumes: Record<string, unknown> };
    const { qdrant } = compose.services;
    assert.equal(qdrant.image, 'qdrant/qdrant:v1.20.0');
    assert.deepEqual(qdrant.ports, ['127.0.0.1:6333:6333']);
    assert.deepEqual(qdrant.volumes, ['qdrant_storage:/qdrant/storage']);
    assert.equal(qdrant.restart, 'unless-stopped');
    assert.ok('qdrant_storage' in compose.volumes);
  });

  it('marks every fixture document as test data', () => {
    const listing = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("node:fs").readdirSync(process.argv[1],{recursive:true})))', join(PACKAGE_ROOT, 'evals', 'fixtures', 'sample-workspace')], { encoding: 'utf8', windowsHide: true });
    const files = (JSON.parse(listing.stdout) as string[]).filter((file) => file.endsWith('.md'));
    assert.ok(files.length > 10);
    for (const file of files) {
      // autocrlf로 체크아웃한 작업 트리에서도 같은 판정이 나오도록 줄바꿈을 맞춘다
      const text = readFileSync(join(PACKAGE_ROOT, 'evals', 'fixtures', 'sample-workspace', file), 'utf8').replaceAll('\r\n', '\n');
      assert.match(text, /^---\n(?:.*\n)*?fixture: true\n/, file);
      assert.match(text, /\n# .*\n\n> 테스트용 자료\(FIXTURE\) — 실제 프로젝트 정책이 아니다\.\n/, file);
    }
  });
});
