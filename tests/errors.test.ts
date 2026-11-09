import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, type TestContext } from 'node:test';
import { EXIT_CODES, getItem, KnowledgeError, openForWrite, openKnowledgeBase, search, type ErrorCode, type RetrievalContext, type SearchRequest } from '../src/index.js';
import { commit, knowledgeFixture, RETRIEVAL_CONFIG_PATH, tempSpace, type KnowledgeFixture } from './helpers.js';

const ORDERS = { 'docs/a.md': '# 배송\n\n배송 본문이다.\n' };
const BILLING = { 'docs/b.md': '---\nkind: contract\n---\n# 정산\n\n정산 본문이다.\n' };
const DELIVERY_ID = 'orders:docs/a.md#배송';
const BILLING_ID = 'billing:docs/b.md#정산';

const request = (extra: Partial<SearchRequest> = {}): SearchRequest => ({ profile: 'master', query: '배송', scope: { projects: ['orders'] }, ...extra });

function corpus(t: TestContext): KnowledgeFixture {
  const fixture = knowledgeFixture(t, [
    { id: 'orders', files: ORDERS },
    { id: 'billing', files: BILLING },
  ]);
  fixture.index();
  return fixture;
}

function failure(fn: () => unknown, code: ErrorCode, reason?: string): KnowledgeError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof KnowledgeError, String(error));
    assert.equal(error.code, code, `${error.message} ${JSON.stringify(error.detail)}`);
    if (reason !== undefined) assert.equal((error.detail as { reason?: string }).reason, reason);
    return error;
  }
  return assert.fail(`expected ${code}`);
}

describe('failure kinds stay distinct', () => {
  it('reports no-results as success, not as an error', (t) => {
    const response = search(corpus(t).context, request({ query: '없는단어입니다' }));
    assert.equal(response.ok, true);
    assert.equal(response.status, 'no-results');
    assert.deepEqual(response.items, []);
  });

  it('gives each failure kind its own exit code', () => {
    const exits = (['invalid-scope', 'index-missing', 'store-unavailable', 'not-found', 'invalid-request', 'config-invalid', 'index-failed'] as const).map((code) => EXIT_CODES[code]);
    assert.equal(new Set(exits).size, exits.length);
    assert.ok(Math.min(...exits) > 0);
  });

  it('separates invalid-scope from index-missing when the store is absent', (t) => {
    const fixture = knowledgeFixture(t, [{ id: 'orders', files: ORDERS }]);
    failure(() => search(fixture.context, request()), 'index-missing', 'no-database');
    failure(() => search(fixture.context, request({ scope: { projects: ['nobody'] } })), 'invalid-scope', 'unknown-project');
    failure(() => search(fixture.context, request({ scope: { projects: ['orders'], allowedLinks: [{ project: 'nobody' }] } })), 'invalid-scope', 'unknown-project');
  });

  it('reports an initialized database without a generation as no-generation', (t) => {
    const fixture = knowledgeFixture(t, [{ id: 'orders', files: ORDERS }]);
    mkdirSync(fixture.space.path('db'), { recursive: true });
    openForWrite(fixture.dbPath).close();
    failure(() => search(fixture.context, request()), 'index-missing', 'no-generation');
    failure(() => search(fixture.context, request({ scope: { projects: ['nobody'] } })), 'invalid-scope', 'unknown-project');
  });

  it('reports a zero-byte database as no-generation', (t) => {
    const fixture = knowledgeFixture(t, [{ id: 'orders', files: ORDERS }]);
    mkdirSync(fixture.space.path('db'), { recursive: true });
    writeFileSync(fixture.dbPath, '');
    failure(() => search(fixture.context, request()), 'index-missing', 'no-generation');
  });

  it('reports a missing generation', (t) => {
    failure(() => search(corpus(t).context, request({ version: { generation: 99 } })), 'index-missing', 'generation-not-found');
  });

  it('reports a commit that was never indexed', (t) => {
    failure(() => search(corpus(t).context, request({ version: { commits: { orders: 'abcdef1' } } })), 'index-missing', 'commit-not-indexed');
  });

  it('reports a configured project absent from the generation', (t) => {
    const fixture = corpus(t);
    fixture.config.sources.push({ ...fixture.config.sources[0]!, id: 'later', project: 'later' });
    failure(() => search(fixture.context, request({ scope: { projects: ['later'] } })), 'index-missing', 'project-not-indexed');
  });

  it('reports an older schema as schema-mismatch', (t) => {
    const fixture = corpus(t);
    const raw = new DatabaseSync(fixture.dbPath);
    // 마이그레이션이 하나뿐인 동안 더 낮은 양수 버전이 없으므로 음수로 옛 버전을 흉내 낸다
    raw.exec('PRAGMA user_version=-1');
    raw.close();
    failure(() => search(fixture.context, request()), 'index-missing', 'schema-mismatch');
  });

  it('reports a newer schema as store-unavailable', (t) => {
    const fixture = corpus(t);
    const raw = new DatabaseSync(fixture.dbPath);
    raw.exec('PRAGMA user_version=9999');
    raw.close();
    failure(() => search(fixture.context, request()), 'store-unavailable', 'unsupported-schema');
  });

  it('reports a garbage file as store-unavailable, not as a missing index', (t) => {
    const fixture = knowledgeFixture(t, [{ id: 'orders', files: ORDERS }]);
    mkdirSync(fixture.space.path('db'), { recursive: true });
    writeFileSync(fixture.dbPath, 'this is definitely not a sqlite database, only some plain text that is long enough');
    const error = failure(() => search(fixture.context, request()), 'store-unavailable');
    assert.equal((error.detail as { errcode: number }).errcode & 0xff, 26);
  });

  it('prefers invalid-scope over store-unavailable when the project is unknown', (t) => {
    const fixture = knowledgeFixture(t, [{ id: 'orders', files: ORDERS }]);
    mkdirSync(fixture.space.path('db'), { recursive: true });
    writeFileSync(fixture.dbPath, 'plain text '.repeat(10));
    failure(() => search(fixture.context, request({ scope: { projects: ['nobody'] } })), 'invalid-scope', 'unknown-project');
  });

  it('validates the request before opening the store', (t) => {
    const fixture = knowledgeFixture(t, [{ id: 'orders', files: ORDERS }]);
    failure(() => search(fixture.context, request({ query: '!!!' })), 'invalid-request', 'no-searchable-terms');
    failure(() => search(fixture.context, request({ scope: { projects: [] } })), 'invalid-scope');
  });
});

describe('index failures', () => {
  it('does not report a failed run as success and keeps the previous generation', (t) => {
    const fixture = corpus(t);
    commit(fixture.repo('orders'), { 'docs/a.md': '# 배송\n\n새로운 배송 본문이다.\n' });
    const error = (() => {
      try {
        fixture.index({
          hooks: {
            beforePublish: () => {
              throw new Error('강제 실패');
            },
          },
        });
      } catch (caught) {
        return caught;
      }
      return assert.fail('expected a failed index run');
    })();
    assert.ok(error instanceof KnowledgeError);
    assert.equal(error.code, 'index-failed');
    assert.notEqual(EXIT_CODES[error.code], 0);

    const response = search(fixture.context, request());
    assert.equal(response.index.generation, 1);
    assert.equal(response.items[0]!.excerpt.includes('새로운'), false);
  });

  it('reports a missing source repository as source-unavailable', (t) => {
    const fixture = corpus(t);
    fixture.config.sources[0]!.path = fixture.space.path('repos', 'gone');
    failure(() => fixture.index(), 'source-unavailable');
    assert.notEqual(EXIT_CODES['source-unavailable'], 0);
  });
});

describe('getItem', () => {
  it('returns the item with its full content under the get schema', (t) => {
    const response = getItem(corpus(t).context, { id: DELIVERY_ID, profile: 'master', scope: { projects: ['orders'] } });
    assert.equal(response.schema, 'agent-knowledge.get');
    assert.equal(response.item.id, DELIVERY_ID);
    assert.equal(response.item.content, '# 배송\n\n배송 본문이다.');
    assert.equal(response.item.provenance.path, 'docs/a.md');
  });

  it('gives no oracle: absent and out-of-scope ids fail identically', (t) => {
    const { context } = corpus(t);
    const outOfScope = failure(() => getItem(context, { id: BILLING_ID, profile: 'master', scope: { projects: ['orders'] } }), 'not-found');
    const absent = failure(() => getItem(context, { id: 'orders:docs/none.md#x', profile: 'master', scope: { projects: ['orders'] } }), 'not-found');
    assert.equal(outOfScope.message, absent.message);
    assert.deepEqual(Object.keys(outOfScope.detail as object), Object.keys(absent.detail as object));
  });

  it('honours allowed link kinds and item ids', (t) => {
    const { context } = corpus(t);
    assert.equal(getItem(context, { id: BILLING_ID, profile: 'master', scope: { projects: ['orders'], allowedLinks: [{ project: 'billing' }] } }).item.id, BILLING_ID);
    failure(() => getItem(context, { id: BILLING_ID, profile: 'master', scope: { projects: ['orders'], allowedLinks: [{ project: 'billing', kinds: ['policy'] }] } }), 'not-found');
    failure(() => getItem(context, { id: BILLING_ID, profile: 'master', scope: { projects: ['orders'], allowedLinks: [{ project: 'billing', itemIds: ['billing:docs/b.md#other'] }] } }), 'not-found');
  });

  it('shares scope validation with search', (t) => {
    const { context } = corpus(t);
    failure(() => getItem(context, { id: DELIVERY_ID, profile: 'code', scope: { projects: ['orders', 'billing'] } }), 'invalid-scope');
    failure(() => getItem(context, { id: DELIVERY_ID, profile: 'master', scope: { projects: ['nobody'] } }), 'invalid-scope');
    failure(() => getItem(context, { id: '', profile: 'master', scope: { projects: ['orders'] } }), 'invalid-request');
    failure(() => getItem(context, { id: DELIVERY_ID, profile: 'master', scope: { projects: ['orders'] }, version: { generation: 99 } }), 'index-missing', 'generation-not-found');
  });

  it('pins to a generation', (t) => {
    const fixture = corpus(t);
    commit(fixture.repo('orders'), { 'docs/a.md': '# 배송\n\n두번째 본문이다.\n' });
    fixture.index();
    const scope = { projects: ['orders'] };
    assert.ok(getItem(fixture.context, { id: DELIVERY_ID, profile: 'master', scope, version: { generation: 1 } }).item.content.includes('배송 본문'));
    assert.ok(getItem(fixture.context, { id: DELIVERY_ID, profile: 'master', scope }).item.content.includes('두번째'));
  });
});

describe('openKnowledgeBase', () => {
  function writeConfig(fixture: KnowledgeFixture, path: string): void {
    const sources = fixture.config.sources.map((source) => ({ id: source.id, project: source.project, path: source.path, include: source.include }));
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, database: { path: fixture.dbPath }, sources }));
  }

  it('indexes and searches from config paths alone', (t) => {
    const fixture = knowledgeFixture(t, [{ id: 'orders', files: ORDERS }]);
    const configPath = fixture.space.path('sources.yaml');
    writeConfig(fixture, configPath);
    const kb = openKnowledgeBase({ configPath, retrievalConfigPath: RETRIEVAL_CONFIG_PATH });
    assert.equal(kb.runIndex({ onProgress: () => {} }).status, 'published');
    assert.equal(kb.search(request()).items[0]!.id, DELIVERY_ID);
    assert.equal(kb.getItem({ id: DELIVERY_ID, profile: 'master', scope: { projects: ['orders'] } }).item.id, DELIVERY_ID);
    assert.equal(kb.dbPath, fixture.dbPath);
  });

  it('uses the packaged retrieval config by default', (t) => {
    const fixture = knowledgeFixture(t, [{ id: 'orders', files: ORDERS }]);
    const configPath = fixture.space.path('sources.yaml');
    writeConfig(fixture, configPath);
    assert.equal(openKnowledgeBase({ configPath }).retrieval.profiles.master.limit, 10);
  });

  it('accepts a db without a config and uses generation projects as the registry', (t) => {
    const fixture = corpus(t);
    const context: RetrievalContext = openKnowledgeBase({ configPath: fixture.space.path('absent.yaml'), dbPath: fixture.dbPath });
    assert.equal(context.sources, null);
    assert.equal(search(context, request()).items[0]!.id, DELIVERY_ID);
    failure(() => search(context, request({ scope: { projects: ['nobody'] } })), 'invalid-scope', 'unknown-project');
  });

  it('cannot index without a config', (t) => {
    const fixture = corpus(t);
    const kb = openKnowledgeBase({ dbPath: fixture.dbPath });
    failure(() => kb.runIndex(), 'config-invalid', 'not-found');
  });

  it('rejects an existing but invalid config even with a db', (t) => {
    const fixture = corpus(t);
    const configPath = fixture.space.path('bad.yaml');
    writeFileSync(configPath, 'schemaVersion: 2\n');
    failure(() => openKnowledgeBase({ configPath, dbPath: fixture.dbPath }), 'config-invalid');
  });

  it('rejects being opened with nothing', () => {
    failure(() => openKnowledgeBase({}), 'config-invalid', 'not-found');
  });

  it('reports a missing retrieval config', (t) => {
    const space = tempSpace(t);
    failure(() => openKnowledgeBase({ dbPath: space.path('k.sqlite'), retrievalConfigPath: space.path('none.yaml') }), 'config-invalid', 'not-found');
  });
});
