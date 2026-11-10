import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import {
  acquireLease,
  EXIT_CODES,
  getItem,
  getItemV2,
  KnowledgeError,
  LEASE_TTL_SECONDS,
  listLeases,
  MAX_LIVE_LEASES,
  openExistingForWrite,
  openForWrite,
  openKnowledgeBase,
  releaseLease,
  renewLease,
  search,
  searchV2,
  Store,
  type ErrorCode,
  type IndexResult,
  type KnowledgeBase,
  type Lease,
  type RunIndexOptions,
  type SearchRequest,
  type SearchRequestV2,
  type SearchResponse,
  type SearchResponseV2,
} from '../src/index.js';
import { MIGRATIONS } from '../src/indexing/schema.js';
import { compareStrings } from '../src/util/compare.js';
import { commit, git, knowledgeFixture, makeRepo, RETRIEVAL_CONFIG_PATH, tempSpace, type KnowledgeFixture, type TempSpace } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INDEX_ID = /^[0-9a-f]{32}$/;
const LEASE_KEYS = ['acquiredAt', 'expiresAt', 'generation', 'holder', 'leaseId', 'renewedAt'];

const doc = (word: string): string => `# Alpha\n\nalpha ${word} 본문이다.\n`;

function failure(fn: () => unknown, code: ErrorCode, reason?: string): KnowledgeError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof KnowledgeError, String(error));
    assert.equal(error.code, code, `${error.message} ${JSON.stringify(error.detail)}`);
    if (reason !== undefined) assert.equal((error.detail as { reason?: string } | undefined)?.reason, reason, JSON.stringify(error.detail));
    return error;
  }
  return assert.fail(`expected ${code}${reason === undefined ? '' : ` (${reason})`}`);
}

/** 첫 세대를 게시한 단일 원본 작업 공간. */
function setup(t: TestContext, retain = 5): KnowledgeFixture {
  const fixture = knowledgeFixture(t, [{ id: 'docs', files: { 'docs/a.md': doc('one') } }], retain);
  assert.equal(fixture.index().generation, 1);
  return fixture;
}

function head(fixture: KnowledgeFixture): string {
  return git(fixture.repo('docs'), ['rev-parse', 'HEAD']);
}

/** 새 커밋을 만들고 색인한다. */
function advance(fixture: KnowledgeFixture, word: string, options: Partial<RunIndexOptions> = {}): IndexResult {
  commit(fixture.repo('docs'), { 'docs/a.md': doc(word) });
  return fixture.index(options);
}

function kbOf(fixture: KnowledgeFixture): KnowledgeBase {
  return openKnowledgeBase({ dbPath: fixture.dbPath, retrievalConfigPath: RETRIEVAL_CONFIG_PATH });
}

function withStore<T>(dbPath: string, fn: (store: Store) => T): T {
  const store = openExistingForWrite(dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function rowsOf<T>(dbPath: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map((row) => ({ ...row })) as T[];
  } finally {
    db.close();
  }
}

/** [세대, activated] 목록. */
function generationsOf(dbPath: string): [number, number][] {
  return rowsOf<{ generation: number; activated: number }>(dbPath, 'SELECT generation, activated FROM generations ORDER BY generation').map((row) => [row.generation, row.activated]);
}

function metaOf(dbPath: string, key: string): string | null {
  return rowsOf<{ value: string }>(dbPath, 'SELECT value FROM meta WHERE key = ?', key)[0]?.value ?? null;
}

function leaseRows(dbPath: string): Lease[] {
  return rowsOf<Lease>(dbPath, 'SELECT lease_id AS leaseId, generation, holder, acquired_at AS acquiredAt, renewed_at AS renewedAt, expires_at AS expiresAt FROM generation_leases ORDER BY lease_id');
}

function runCount(dbPath: string): number {
  return rowsOf<{ count: number }>(dbPath, 'SELECT count(*) AS count FROM index_runs')[0]!.count;
}

function request(version?: SearchRequest['version']): SearchRequest {
  return { profile: 'master', query: 'alpha', scope: { projects: ['docs'] }, ...(version === undefined ? {} : { version }) };
}

function requestV2(version?: SearchRequestV2['version']): SearchRequestV2 {
  return { responseVersion: 2, profile: 'master', query: 'alpha', scope: { projects: ['docs'] }, ...(version === undefined ? {} : { version }) };
}

function selected(response: SearchResponse | SearchResponseV2): [number, string] {
  return [response.index.generation, response.index.sources[0]!.commit];
}

const ttlOf = (lease: Lease): number => (Date.parse(lease.expiresAt) - Date.parse(lease.acquiredAt)) / 1000;
const renewedTtlOf = (lease: Lease): number => (Date.parse(lease.expiresAt) - Date.parse(lease.renewedAt)) / 1000;
const later = (seconds: number): Date => new Date(Date.now() + seconds * 1000);
const shifted = (iso: string, offsetMs = 0): Date => new Date(Date.parse(iso) + offsetMs);

describe('lease requests', () => {
  it('accepts exactly the TTL bounds and rejects everything else as invalid-ttl', (t) => {
    const fixture = setup(t);
    const kb = kbOf(fixture);
    for (const ttl of [LEASE_TTL_SECONDS.min, LEASE_TTL_SECONDS.max]) assert.equal(ttlOf(kb.leases.acquire({ holder: 'bounds', ttlSeconds: ttl })), ttl);
    assert.equal(ttlOf(kb.leases.acquire({ holder: 'default' })), LEASE_TTL_SECONDS.default);
    for (const ttl of [LEASE_TTL_SECONDS.min - 1, LEASE_TTL_SECONDS.max + 1, 0, -60, 60.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = failure(() => kb.leases.acquire({ holder: 'bounds', ttlSeconds: ttl }), 'invalid-request', 'invalid-ttl');
      assert.equal((error.detail as { min: number }).min, LEASE_TTL_SECONDS.min);
      assert.equal((error.detail as { max: number }).max, LEASE_TTL_SECONDS.max);
    }
    assert.equal(leaseRows(fixture.dbPath).length, 3);
    assert.deepEqual(kb.capabilities().leases, { ttlSeconds: { ...LEASE_TTL_SECONDS }, maxLive: MAX_LIVE_LEASES });
  });

  it('rejects empty, overlong and control-character holders as invalid-holder', (t) => {
    const fixture = setup(t);
    const kb = kbOf(fixture);
    // 길이는 UTF-16 단위로 센다. 이모지 하나가 둘을 차지한다
    for (const holder of ['a', 'x'.repeat(200), '작업 에이전트 #7', '😀'.repeat(100)]) assert.equal(kb.leases.acquire({ holder }).holder, holder);
    for (const holder of ['', 'x'.repeat(201), '😀'.repeat(100) + 'x', 'a\nb', 'a\tb', '\u0000', 'a\u007f', 'a\u0085', 'a\rb']) {
      failure(() => kb.leases.acquire({ holder }), 'invalid-request', 'invalid-holder');
    }
    assert.equal(leaseRows(fixture.dbPath).length, 4);
  });

  it('leases the active generation when none is named and a named retained generation otherwise', (t) => {
    const fixture = setup(t);
    advance(fixture, 'two');
    const kb = kbOf(fixture);
    const active = kb.leases.acquire({ holder: 'agent' });
    assert.equal(active.generation, 2);
    assert.deepEqual(Object.keys(active).sort(compareStrings), LEASE_KEYS);
    assert.match(active.leaseId, UUID);
    assert.equal(active.acquiredAt, active.renewedAt);
    const older = kb.leases.acquire({ holder: 'agent', generation: 1 });
    assert.equal(older.generation, 1);
    assert.notEqual(older.leaseId, active.leaseId);
    assert.deepEqual(leaseRows(fixture.dbPath), [active, older].sort((a, b) => compareStrings(a.leaseId, b.leaseId)));
  });

  it('fails with generation-not-found for a generation that is not retained instead of leasing the active one', (t) => {
    const fixture = setup(t);
    const kb = kbOf(fixture);
    for (const generation of [2, 99]) {
      const error = failure(() => kb.leases.acquire({ holder: 'agent', generation }), 'index-missing', 'generation-not-found');
      assert.equal((error.detail as { generation: number }).generation, generation);
    }
    assert.deepEqual(leaseRows(fixture.dbPath), []);
  });

  it('rejects a generation that is not a positive integer instead of leasing the active one', (t) => {
    const fixture = setup(t);
    const kb = kbOf(fixture);
    // 타입 검사를 거치지 않은 호출자의 null이 생략으로 읽혀 활성 세대에 걸리면 안 된다
    for (const generation of [0, -1, 1.5, null, '1', Number.NaN] as unknown[]) {
      failure(() => kb.leases.acquire({ holder: 'agent', generation: generation as number }), 'invalid-request', 'invalid-generation');
    }
    for (const holder of [undefined, 5, null] as unknown[]) {
      failure(() => kb.leases.acquire({ holder: holder as string }), 'invalid-request', 'invalid-holder');
    }
    assert.deepEqual(leaseRows(fixture.dbPath), []);
  });

  it('reports no-generation when there is no active generation to lease', (t) => {
    const space = tempSpace(t);
    const dbPath = space.path('empty.sqlite');
    openForWrite(dbPath).close();
    const kb = openKnowledgeBase({ dbPath, retrievalConfigPath: RETRIEVAL_CONFIG_PATH });
    failure(() => kb.leases.acquire({ holder: 'agent' }), 'index-missing', 'no-generation');
    failure(() => kb.leases.acquire({ holder: 'agent', generation: 1 }), 'index-missing', 'generation-not-found');
  });

  it('refuses a mismatched indexId before looking at the generation', (t) => {
    const fixture = setup(t);
    const kb = kbOf(fixture);
    const actual = metaOf(fixture.dbPath, 'index_id')!;
    assert.match(actual, INDEX_ID);
    const other = actual === '0'.repeat(32) ? '1'.repeat(32) : '0'.repeat(32);
    const error = failure(() => kb.leases.acquire({ holder: 'agent', indexId: other }), 'index-missing', 'index-id-mismatch');
    assert.deepEqual(error.detail, { reason: 'index-id-mismatch', expected: other, actual });
    failure(() => kb.leases.acquire({ holder: 'agent', indexId: other, generation: 99 }), 'index-missing', 'index-id-mismatch');
    assert.deepEqual(leaseRows(fixture.dbPath), []);
    assert.equal(kb.leases.acquire({ holder: 'agent', indexId: actual }).generation, 1);
  });

  it('refuses more than MAX_LIVE_LEASES live leases but does not count expired ones', (t) => {
    const fixture = setup(t);
    const now = new Date().toISOString();
    const future = later(3600).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const db = new DatabaseSync(fixture.dbPath);
    try {
      db.exec('BEGIN');
      const insert = db.prepare('INSERT INTO generation_leases(lease_id, generation, holder, acquired_at, renewed_at, expires_at) VALUES(?,?,?,?,?,?)');
      for (let index = 0; index < MAX_LIVE_LEASES - 1; index++) insert.run(`bulk-live-${String(index).padStart(4, '0')}`, 1, 'bulk', now, now, future);
      for (let index = 0; index < 3; index++) insert.run(`bulk-expired-${index}`, 1, 'bulk', past, past, past);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const kb = kbOf(fixture);
    kb.leases.acquire({ holder: 'last' });
    const error = failure(() => kb.leases.acquire({ holder: 'one-too-many' }), 'invalid-request', 'too-many-leases');
    assert.equal((error.detail as { max: number }).max, MAX_LIVE_LEASES);
    assert.equal(kb.leases.list('one-too-many').length, 0);

    // 임대를 만들 수 없으면 게시하지 않는다. 임대 없이 남은 세대는 호출자가 믿고 쓸 수 없다.
    // 수집 전에 요청 오류로 거절하므로 reason이 남고 실행 기록도 남지 않는다. 바뀐 원본과 재사용 경로 모두 같다
    const before = { generations: generationsOf(fixture.dbPath), last: metaOf(fixture.dbPath, 'last_generation'), runs: runCount(fixture.dbPath) };
    const reuseError = failure(() => fixture.index({ lease: { holder: 'ci' } }), 'invalid-request', 'too-many-leases');
    assert.equal((reuseError.detail as { max: number }).max, MAX_LIVE_LEASES);
    commit(fixture.repo('docs'), { 'docs/a.md': doc('two') });
    failure(() => fixture.index({ lease: { holder: 'ci' } }), 'invalid-request', 'too-many-leases');
    assert.deepEqual({ generations: generationsOf(fixture.dbPath), last: metaOf(fixture.dbPath, 'last_generation'), runs: runCount(fixture.dbPath) }, before);
    assert.equal(leaseRows(fixture.dbPath).filter((lease) => lease.holder === 'ci').length, 0);

    assert.equal(fixture.index().generation, 2);
    assert.deepEqual(leaseRows(fixture.dbPath).filter((lease) => lease.leaseId.startsWith('bulk-expired-')), []);
  });
});

describe('lease renewal, release and listing', () => {
  it('renews a live lease in place and keeps its identity', (t) => {
    const fixture = setup(t);
    const kb = kbOf(fixture);
    const at = new Date(Date.now() - 10_000);
    const lease = withStore(fixture.dbPath, (store) => acquireLease(store, { holder: 'agent', ttlSeconds: 600, clock: () => at }));
    assert.equal(lease.acquiredAt, at.toISOString());
    const renewed = kb.leases.renew(lease.leaseId, 1200);
    assert.equal(renewed.leaseId, lease.leaseId);
    assert.equal(renewed.generation, lease.generation);
    assert.equal(renewed.holder, lease.holder);
    assert.equal(renewed.acquiredAt, lease.acquiredAt);
    assert.ok(renewed.renewedAt > lease.renewedAt);
    assert.equal(renewedTtlOf(renewed), 1200);
    assert.deepEqual(leaseRows(fixture.dbPath), [renewed]);
    failure(() => kb.leases.renew(lease.leaseId, LEASE_TTL_SECONDS.max + 1), 'invalid-request', 'invalid-ttl');
    assert.deepEqual(leaseRows(fixture.dbPath), [renewed]);
    assert.equal(renewedTtlOf(kb.leases.renew(lease.leaseId)), LEASE_TTL_SECONDS.default);
  });

  it('reports lease-not-found for an unknown lease and lease-expired for an expired one', (t) => {
    const fixture = setup(t);
    const kb = kbOf(fixture);
    const missing = failure(() => kb.leases.renew('00000000-0000-4000-8000-000000000000'), 'not-found', 'lease-not-found');
    assert.equal((missing.detail as { leaseId: string }).leaseId, '00000000-0000-4000-8000-000000000000');

    const acquiredAt = new Date(Date.now() - 2 * 3_600_000);
    const stale = withStore(fixture.dbPath, (store) => acquireLease(store, { holder: 'agent', ttlSeconds: 60, clock: () => acquiredAt }));
    const expired = failure(() => kb.leases.renew(stale.leaseId, 600), 'not-found', 'lease-expired');
    assert.equal((expired.detail as { expiresAt: string }).expiresAt, stale.expiresAt);
    assert.deepEqual(leaseRows(fixture.dbPath), [stale]);

    // 만료 시각과 같은 순간은 이미 만료다
    withStore(fixture.dbPath, (store) => failure(() => renewLease(store, stale.leaseId, 600, () => shifted(stale.expiresAt)), 'not-found', 'lease-expired'));
    const justBefore = shifted(stale.expiresAt, -1);
    const revived = withStore(fixture.dbPath, (store) => renewLease(store, stale.leaseId, 600, () => justBefore));
    assert.equal(revived.renewedAt, justBefore.toISOString());
    assert.equal(revived.expiresAt, new Date(justBefore.getTime() + 600_000).toISOString());
  });

  it('releases idempotently', (t) => {
    const fixture = setup(t);
    const kb = kbOf(fixture);
    const lease = kb.leases.acquire({ holder: 'agent' });
    assert.deepEqual(kb.leases.release(lease.leaseId), { released: true });
    assert.deepEqual(kb.leases.release(lease.leaseId), { released: false });
    assert.deepEqual(withStore(fixture.dbPath, (store) => releaseLease(store, 'never-issued')), { released: false });
    failure(() => kb.leases.renew(lease.leaseId), 'not-found', 'lease-not-found');
    assert.deepEqual(kb.leases.list(), []);
  });

  it('lists leases sorted by leaseId with an expired flag and an optional holder filter', (t) => {
    const fixture = setup(t);
    advance(fixture, 'two');
    const kb = kbOf(fixture);
    const past = new Date(Date.now() - 3_600_000);
    const stale = withStore(fixture.dbPath, (store) => acquireLease(store, { holder: 'worker', ttlSeconds: 60, generation: 1, clock: () => past }));
    const live = [kb.leases.acquire({ holder: 'worker' }), kb.leases.acquire({ holder: 'worker', generation: 1 }), kb.leases.acquire({ holder: 'other' })];
    const listed = kb.leases.list();
    assert.deepEqual(listed.map((lease) => lease.leaseId), [stale, ...live].map((lease) => lease.leaseId).sort(compareStrings));
    for (const lease of listed) {
      assert.deepEqual(Object.keys(lease).sort(compareStrings), [...LEASE_KEYS, 'expired'].sort(compareStrings));
      assert.equal(lease.expired, lease.leaseId === stale.leaseId);
    }
    assert.deepEqual(kb.leases.list('other').map((lease) => lease.leaseId), [live[2]!.leaseId]);
    assert.deepEqual(kb.leases.list('worker').map((lease) => lease.leaseId), [stale, live[0]!, live[1]!].map((lease) => lease.leaseId).sort(compareStrings));
    assert.deepEqual(kb.leases.list('nobody'), []);

    // 목록은 읽기 전용이다. 만료된 임대를 지우지 않는다
    assert.equal(leaseRows(fixture.dbPath).length, 4);
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.deepEqual(listLeases(db, undefined, past).map((lease) => lease.expired), [false, false, false, false]);
    } finally {
      db.close();
    }
  });
});

describe('generation GC with leases', () => {
  it('keeps a leased generation beyond retainGenerations and drops it at the next run after release', (t) => {
    const fixture = setup(t, 1);
    const first = head(fixture);
    const kb = kbOf(fixture);
    const lease = kb.leases.acquire({ holder: 'review' });
    assert.equal(lease.generation, 1);
    for (const word of ['two', 'three', 'four']) {
      const result = advance(fixture, word);
      assert.deepEqual(generationsOf(fixture.dbPath), [[1, 1], [result.generation, 1]]);
    }
    assert.deepEqual(selected(search(fixture.context, request({ generation: 1 }))), [1, first]);
    const itemId = search(fixture.context, request({ generation: 1 })).items[0]!.id;
    assert.equal(getItem(fixture.context, { id: itemId, profile: 'master', scope: { projects: ['docs'] }, version: { generation: 1 } }).index.generation, 1);
    assert.equal(search(fixture.context, request()).index.generation, 4);

    assert.deepEqual(kb.leases.release(lease.leaseId), { released: true });
    const unchanged = fixture.index();
    assert.deepEqual([unchanged.status, unchanged.generation], ['unchanged', 4]);
    assert.deepEqual(generationsOf(fixture.dbPath), [[4, 1]]);
    failure(() => search(fixture.context, request({ generation: 1 })), 'index-missing', 'generation-not-found');
    failure(() => getItem(fixture.context, { id: itemId, profile: 'master', scope: { projects: ['docs'] }, version: { generation: 1 } }), 'index-missing', 'generation-not-found');
    failure(() => search(fixture.context, request({ generation: 1, commits: { docs: first } })), 'index-missing', 'generation-not-found');
  });

  it('drops a generation once its lease expires by the run clock and deletes the expired lease', (t) => {
    const fixture = setup(t, 1);
    const kb = kbOf(fixture);
    const short = kb.leases.acquire({ holder: 'short', ttlSeconds: 60 });
    advance(fixture, 'two');
    const long = kb.leases.acquire({ holder: 'long', ttlSeconds: 3600 });
    assert.deepEqual(generationsOf(fixture.dbPath), [[1, 1], [2, 1]]);

    // 만료 시각과 같은 순간의 실행은 이미 만료된 것으로 본다
    const result = fixture.index({ clock: () => shifted(short.expiresAt) });
    assert.equal(result.status, 'unchanged');
    assert.deepEqual(generationsOf(fixture.dbPath), [[2, 1]]);
    assert.deepEqual(leaseRows(fixture.dbPath), [long]);
    failure(() => search(fixture.context, request({ generation: 1 })), 'index-missing', 'generation-not-found');
    failure(() => kb.leases.renew(short.leaseId), 'not-found', 'lease-not-found');
    assert.deepEqual(kb.leases.release(short.leaseId), { released: false });
  });

  it('keeps a lease that is still live by the run clock', (t) => {
    const fixture = setup(t, 1);
    const lease = kbOf(fixture).leases.acquire({ holder: 'agent', ttlSeconds: 600 });
    advance(fixture, 'two', { clock: () => shifted(lease.acquiredAt, 300_000) });
    advance(fixture, 'three', { clock: () => shifted(lease.expiresAt, -1) });
    assert.deepEqual(generationsOf(fixture.dbPath), [[1, 1], [3, 1]]);
    assert.deepEqual(leaseRows(fixture.dbPath), [lease]);
  });

  it('removes expired leases on an unchanged run even when no generation needs trimming', (t) => {
    const fixture = setup(t);
    const past = new Date(Date.now() - 3_600_000);
    withStore(fixture.dbPath, (store) => acquireLease(store, { holder: 'stale', ttlSeconds: 60, clock: () => past }));
    const live = kbOf(fixture).leases.acquire({ holder: 'live' });
    assert.equal(fixture.index().status, 'unchanged');
    assert.deepEqual(leaseRows(fixture.dbPath), [live]);
    assert.deepEqual(generationsOf(fixture.dbPath), [[1, 1]]);
  });

  it('keeps a leased inactive generation and drops an unleased one at the next GC', (t) => {
    const fixture = setup(t);
    const kb = kbOf(fixture);
    assert.equal(advance(fixture, 'two', { activate: false }).generation, 2);
    assert.equal(advance(fixture, 'three', { activate: false }).generation, 3);
    assert.deepEqual(generationsOf(fixture.dbPath), [[1, 1], [3, 0]]);
    failure(() => search(fixture.context, request({ generation: 2 })), 'index-missing', 'generation-not-found');

    kb.leases.acquire({ holder: 'branch', generation: 3 });
    advance(fixture, 'four');
    advance(fixture, 'five');
    assert.deepEqual(generationsOf(fixture.dbPath), [[1, 1], [3, 0], [4, 1], [5, 1]]);
    assert.equal(search(fixture.context, request({ generation: 3 })).index.generation, 3);
  });

  it('serialises a lease acquisition with the publish transaction that collects its generation', (t) => {
    const fixture = setup(t, 1);
    commit(fixture.repo('docs'), { 'docs/a.md': doc('two') });
    let attempt: unknown = 'not-called';
    const result = fixture.index({
      hooks: {
        beforePublish() {
          // 바쁜 대기 없이 바로 실패하도록 시간 제한 0인 연결을 쓴다
          const store = new Store(new DatabaseSync(fixture.dbPath, { timeout: 0 }));
          try {
            attempt = acquireLease(store, { holder: 'late', generation: 1 });
          } catch (error) {
            attempt = error;
          } finally {
            store.close();
          }
        },
      },
    });
    assert.ok(attempt instanceof KnowledgeError, String(attempt));
    assert.equal(attempt.code, 'store-unavailable');
    assert.equal(result.generation, 2);
    assert.deepEqual(generationsOf(fixture.dbPath), [[2, 1]]);

    const kb = kbOf(fixture);
    failure(() => kb.leases.acquire({ holder: 'late', generation: 1 }), 'index-missing', 'generation-not-found');
    assert.deepEqual(kb.leases.list(), []);
  });
});

describe('runIndex lease option', () => {
  it('creates the lease for the published generation inside the publish', (t) => {
    const fixture = setup(t, 1);
    const plain = advance(fixture, 'two');
    assert.equal(Object.hasOwn(plain, 'lease'), false);

    const at = new Date();
    const result = advance(fixture, 'three', { lease: { holder: 'ci', ttlSeconds: 600 }, clock: () => at });
    assert.equal(result.status, 'published');
    assert.deepEqual(result.lease, { leaseId: result.lease!.leaseId, generation: result.generation, holder: 'ci', acquiredAt: at.toISOString(), renewedAt: at.toISOString(), expiresAt: new Date(at.getTime() + 600_000).toISOString() });
    assert.deepEqual(leaseRows(fixture.dbPath), [result.lease]);

    advance(fixture, 'four');
    advance(fixture, 'five');
    assert.deepEqual(generationsOf(fixture.dbPath).map(([generation]) => generation), [3, 5]);
    assert.equal(ttlOf(advance(fixture, 'six', { lease: { holder: 'ci' } }).lease!), LEASE_TTL_SECONDS.default);
  });

  it('leases the reused generation on an unchanged run', (t) => {
    const fixture = setup(t);
    const result = fixture.index({ lease: { holder: 'ci', ttlSeconds: 120 } });
    assert.deepEqual([result.status, result.generation, result.lease?.generation, result.lease?.holder], ['unchanged', 1, 1, 'ci']);

    advance(fixture, 'two', { activate: false });
    const reused = fixture.index({ activate: false, lease: { holder: 'branch' } });
    assert.deepEqual([reused.status, reused.generation, reused.lease?.generation], ['unchanged', 2, 2]);
    assert.deepEqual(leaseRows(fixture.dbPath).map((lease) => [lease.holder, lease.generation]).sort((a, b) => compareStrings(String(a[0]), String(b[0]))), [['branch', 2], ['ci', 1]]);
  });

  it('takes the lease, collects garbage and reads the result in one write transaction on an unchanged run', (t) => {
    const fixture = setup(t);
    const at = new Date();
    let calls = 0;
    let other: unknown = 'not-called';
    // 첫 호출은 수집 전 상한 확인, 두 번째는 재사용 트랜잭션 안이다. 그때 다른 연결이 쓰기 잠금을 잡으면
    // 임대를 커밋한 뒤 GC가 실패해 호출자가 모르는 임대가 남을 수 있다
    const clock = (): Date => {
      calls++;
      if (calls === 2) {
        const db = new DatabaseSync(fixture.dbPath, { timeout: 0 });
        try {
          db.exec('BEGIN IMMEDIATE');
          db.exec('ROLLBACK');
          other = 'acquired';
        } catch (error) {
          other = error;
        } finally {
          db.close();
        }
      }
      return at;
    };
    const result = fixture.index({ lease: { holder: 'ci' }, clock });
    assert.equal(result.status, 'unchanged');
    assert.ok(other instanceof Error, `another writer got the lock: ${String(other)}`);
    assert.deepEqual(leaseRows(fixture.dbPath), [result.lease]);
  });

  it('validates the lease request before collecting or publishing anything', (t) => {
    const fixture = setup(t);
    commit(fixture.repo('docs'), { 'docs/a.md': doc('two') });
    const runs = runCount(fixture.dbPath);
    failure(() => fixture.index({ lease: { holder: '' } }), 'invalid-request', 'invalid-holder');
    failure(() => fixture.index({ lease: { holder: 'ci', ttlSeconds: 59 } }), 'invalid-request', 'invalid-ttl');
    failure(() => fixture.index({ lease: { holder: 'ci', ttlSeconds: LEASE_TTL_SECONDS.max + 1 } }), 'invalid-request', 'invalid-ttl');
    assert.equal(runCount(fixture.dbPath), runs);
    assert.deepEqual(generationsOf(fixture.dbPath), [[1, 1]]);
    assert.deepEqual(leaseRows(fixture.dbPath), []);
  });
});

describe('activate: false', () => {
  it('lets a named generation be read when the database has no active generation yet', (t) => {
    const fixture = knowledgeFixture(t, [{ id: 'docs', files: { 'docs/a.md': doc('one') } }]);
    const result = fixture.index({ activate: false });
    assert.deepEqual([result.status, result.generation], ['published', 1]);
    assert.equal(metaOf(fixture.dbPath, 'active_generation'), null);
    // 지정하지 않으면 대신 고를 세대가 없다
    failure(() => search(fixture.context, request()), 'index-missing', 'no-generation');
    failure(() => kbOf(fixture).leases.acquire({ holder: 'agent' }), 'index-missing', 'no-generation');
    // 번호로 지정하면 읽을 수 있다
    assert.equal(search(fixture.context, request({ generation: 1 })).index.generation, 1);
    const v2 = searchV2(fixture.context, requestV2({ generation: 1, exact: true }));
    assert.deepEqual([v2.index.generation, v2.index.activated, v2.index.activeGeneration], [1, false, null]);
    const lease = kbOf(fixture).leases.acquire({ holder: 'agent', generation: 1 });
    const verified = kbOf(fixture).verify({ profile: 'master', scope: { projects: ['docs'] }, references: [v2.items[0]!.ref], against: { generation: 1 } });
    assert.deepEqual([verified.against, verified.results[0]!.reference.verdict, verified.results[0]!.current.state], [{ indexGeneration: 1, activeGeneration: null }, 'intact', 'same']);
    assert.equal(kbOf(fixture).leases.release(lease.leaseId).released, true);
  });

  it('publishes a generation without changing the active one', (t) => {
    const fixture = setup(t);
    const first = head(fixture);
    const result = advance(fixture, 'two', { activate: false });
    const second = head(fixture);
    assert.deepEqual([result.status, result.generation], ['published', 2]);
    assert.equal(metaOf(fixture.dbPath, 'active_generation'), '1');
    assert.equal(metaOf(fixture.dbPath, 'last_generation'), '2');
    assert.deepEqual(generationsOf(fixture.dbPath), [[1, 1], [2, 0]]);

    assert.deepEqual(selected(search(fixture.context, request())), [1, first]);
    assert.deepEqual(selected(search(fixture.context, request({ generation: 2 }))), [2, second]);
    const v2 = searchV2(fixture.context, requestV2({ generation: 2 }));
    assert.deepEqual([v2.index.generation, v2.index.activated, v2.index.activeGeneration, v2.index.selection], [2, false, 1, { by: 'generation', exact: false }]);
    const active = searchV2(fixture.context, requestV2());
    assert.deepEqual([active.index.generation, active.index.activated, active.index.activeGeneration, active.index.selection], [1, true, 1, { by: 'active', exact: false }]);
    assert.equal(kbOf(fixture).leases.acquire({ holder: 'agent' }).generation, 1);
  });

  it('ignores non-activated generations in commit selection unless the generation is named', (t) => {
    const fixture = setup(t);
    const first = head(fixture);
    advance(fixture, 'two', { activate: false });
    const second = head(fixture);

    failure(() => search(fixture.context, request({ commits: { docs: second } })), 'index-missing', 'commit-not-indexed');
    failure(() => searchV2(fixture.context, requestV2({ commits: { docs: second } })), 'index-missing', 'commit-not-indexed');
    assert.deepEqual(selected(search(fixture.context, request({ commits: { docs: first } }))), [1, first]);
    assert.deepEqual(selected(search(fixture.context, request({ generation: 2, commits: { docs: second } }))), [2, second]);
    assert.deepEqual(selected(search(fixture.context, request({ generation: 2, commits: { docs: second.slice(0, 7).toUpperCase() } }))), [2, second]);
    // 지정한 세대가 커밋과 맞지 않으면 그 이하의 활성화했던 세대에서 찾는다
    assert.deepEqual(selected(search(fixture.context, request({ generation: 2, commits: { docs: first } }))), [1, first]);
    const v2 = searchV2(fixture.context, requestV2({ generation: 2, commits: { docs: second } }));
    assert.deepEqual([v2.index.generation, v2.index.selection], [2, { by: 'generation+commits', exact: false }]);

    // 이름으로 지정하지 않은 비활성 세대는 상한 아래에 있어도 고르지 않는다
    kbOf(fixture).leases.acquire({ holder: 'branch', generation: 2 });
    advance(fixture, 'three');
    assert.deepEqual(generationsOf(fixture.dbPath), [[1, 1], [2, 0], [3, 1]]);
    failure(() => search(fixture.context, request({ generation: 3, commits: { docs: second } })), 'index-missing', 'commit-not-indexed');
    failure(() => search(fixture.context, request({ commits: { docs: second } })), 'index-missing', 'commit-not-indexed');
  });

  it('reuses a retained generation with the same fingerprint for a non-activating run and compares only the active one otherwise', (t) => {
    const fixture = setup(t);
    advance(fixture, 'two', { activate: false });
    const again = fixture.index({ activate: false });
    assert.deepEqual([again.status, again.generation], ['unchanged', 2]);
    assert.deepEqual(generationsOf(fixture.dbPath), [[1, 1], [2, 0]]);

    // 활성화하는 실행은 활성 세대와만 비교하므로 같은 내용의 비활성 세대가 있어도 새로 게시한다
    const activated = fixture.index();
    assert.deepEqual([activated.status, activated.generation], ['published', 3]);
    assert.equal(metaOf(fixture.dbPath, 'active_generation'), '3');
    assert.deepEqual(generationsOf(fixture.dbPath), [[1, 1], [3, 1]]);

    const unchanged = fixture.index();
    assert.deepEqual([unchanged.status, unchanged.generation], ['unchanged', 3]);
    const inactiveAgain = fixture.index({ activate: false });
    assert.deepEqual([inactiveAgain.status, inactiveAgain.generation], ['unchanged', 3]);
    assert.equal(metaOf(fixture.dbPath, 'active_generation'), '3');
  });
});

describe('exact generation selection', () => {
  function threeGenerations(t: TestContext): { fixture: KnowledgeFixture; commits: string[] } {
    const fixture = setup(t);
    const commits = [head(fixture)];
    for (const word of ['two', 'three']) {
      advance(fixture, word);
      commits.push(head(fixture));
    }
    assert.deepEqual(generationsOf(fixture.dbPath), [[1, 1], [2, 1], [3, 1]]);
    return { fixture, commits };
  }

  it('selects the newest generation at or below the named one that matches the commits', (t) => {
    const { fixture, commits } = threeGenerations(t);
    const [a, b, c] = commits as [string, string, string];
    assert.deepEqual(selected(search(fixture.context, request({ generation: 3, commits: { docs: a } }))), [1, a]);
    assert.deepEqual(selected(search(fixture.context, request({ generation: 3, commits: { docs: b } }))), [2, b]);
    assert.deepEqual(selected(search(fixture.context, request({ generation: 2, commits: { docs: b } }))), [2, b]);
    assert.deepEqual(selected(search(fixture.context, request({ commits: { docs: c } }))), [3, c]);
    failure(() => search(fixture.context, request({ generation: 1, commits: { docs: b } })), 'index-missing', 'commit-not-indexed');
  });

  it('uses only the named generation with exact and fails with commit-not-in-generation otherwise', (t) => {
    const { fixture, commits } = threeGenerations(t);
    const [a, b] = commits as [string, string, string];
    const error = failure(() => searchV2(fixture.context, requestV2({ generation: 3, commits: { docs: a }, exact: true })), 'index-missing', 'commit-not-in-generation');
    assert.equal((error.detail as { generation: number }).generation, 3);
    failure(() => searchV2(fixture.context, requestV2({ generation: 1, commits: { docs: b }, exact: true })), 'index-missing', 'commit-not-in-generation');

    const exact = searchV2(fixture.context, requestV2({ generation: 1, commits: { docs: a }, exact: true }));
    assert.deepEqual([...selected(exact), exact.index.selection], [1, a, { by: 'generation+commits', exact: true }]);
    const named = searchV2(fixture.context, requestV2({ generation: 2, exact: true }));
    assert.deepEqual([...selected(named), named.index.selection], [2, b, { by: 'generation', exact: true }]);
    const loose = searchV2(fixture.context, requestV2({ generation: 3, commits: { docs: a }, exact: false }));
    assert.deepEqual([...selected(loose), loose.index.selection], [1, a, { by: 'generation+commits', exact: false }]);

    const itemId = exact.items[0]!.id;
    const get = (version: SearchRequestV2['version']) => getItemV2(fixture.context, { responseVersion: 2, id: itemId, profile: 'master', scope: { projects: ['docs'] }, version });
    assert.equal(get({ generation: 1, commits: { docs: a }, exact: true }).index.generation, 1);
    failure(() => get({ generation: 3, commits: { docs: a }, exact: true }), 'index-missing', 'commit-not-in-generation');
  });

  it('rejects exact without a generation and exact or indexId in a version 1 request', (t) => {
    const { fixture, commits } = threeGenerations(t);
    const [a] = commits as [string];
    for (const version of [{ exact: true }, { commits: { docs: a }, exact: true }]) {
      const error = failure(() => searchV2(fixture.context, requestV2(version)), 'invalid-request');
      assert.ok((error.detail as { issues: { path: string }[] }).issues.some((issue) => issue.path === 'version.exact'), JSON.stringify(error.detail));
    }
    assert.deepEqual(searchV2(fixture.context, requestV2({ exact: false })).index.selection, { by: 'active', exact: false });
    const v1 = failure(() => search(fixture.context, { ...request({ generation: 1 }), version: { generation: 1, exact: true } } as SearchRequest), 'invalid-request', 'response-version-2-required');
    assert.deepEqual((v1.detail as { fields: string[] }).fields, ['version.exact']);
    const indexId = failure(() => search(fixture.context, { ...request(), version: { indexId: '0'.repeat(32) } } as SearchRequest), 'invalid-request', 'response-version-2-required');
    assert.deepEqual((indexId.detail as { fields: string[] }).fields, ['version.indexId']);
  });

  it('checks the requested indexId against the database', (t) => {
    const { fixture } = threeGenerations(t);
    const actual = metaOf(fixture.dbPath, 'index_id')!;
    const other = actual === 'f'.repeat(32) ? 'e'.repeat(32) : 'f'.repeat(32);
    failure(() => searchV2(fixture.context, requestV2({ indexId: other, generation: 2 })), 'index-missing', 'index-id-mismatch');
    const matched = searchV2(fixture.context, requestV2({ indexId: actual, generation: 2, exact: true }));
    assert.deepEqual([matched.index.generation, matched.index.indexId], [2, actual]);
  });

  it('never falls back to the active generation for a generation that is not retained', (t) => {
    const { fixture, commits } = threeGenerations(t);
    const c = commits[2]!;
    const itemId = search(fixture.context, request()).items[0]!.id;
    failure(() => search(fixture.context, request({ generation: 99 })), 'index-missing', 'generation-not-found');
    failure(() => search(fixture.context, request({ generation: 99, commits: { docs: c } })), 'index-missing', 'generation-not-found');
    failure(() => searchV2(fixture.context, requestV2({ generation: 99, commits: { docs: c }, exact: true })), 'index-missing', 'generation-not-found');
    failure(() => getItem(fixture.context, { id: itemId, profile: 'master', scope: { projects: ['docs'] }, version: { generation: 99 } }), 'index-missing', 'generation-not-found');
    failure(() => getItemV2(fixture.context, { responseVersion: 2, id: itemId, profile: 'master', scope: { projects: ['docs'] }, version: { generation: 99, exact: true } }), 'index-missing', 'generation-not-found');
  });
});

describe('lease storage', () => {
  it('stores only generation protection, never task or approval state', (t) => {
    const fixture = setup(t);
    const columns = rowsOf<{ name: string }>(fixture.dbPath, 'PRAGMA table_info(generation_leases)').map((column) => column.name);
    assert.deepEqual(columns, ['lease_id', 'generation', 'holder', 'acquired_at', 'renewed_at', 'expires_at']);
    const keys = rowsOf<{ table: string; from: string; on_delete: string }>(fixture.dbPath, 'PRAGMA foreign_key_list(generation_leases)').map((key) => [key.table, key.from, key.on_delete]);
    assert.deepEqual(keys, [['generations', 'generation', 'CASCADE']]);
  });

  it('refuses lease operations on a schema 1 database without migrating it', (t) => {
    const space = tempSpace(t);
    const dbPath = space.path('old.sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(MIGRATIONS[0]!);
      db.exec("INSERT INTO meta(key, value) VALUES('active_generation', '1')");
      db.exec('PRAGMA user_version=1');
    } finally {
      db.close();
    }
    const kb = openKnowledgeBase({ dbPath, retrievalConfigPath: RETRIEVAL_CONFIG_PATH });
    failure(() => kb.leases.acquire({ holder: 'agent' }), 'index-missing', 'schema-upgrade-required');
    failure(() => kb.leases.renew('x'), 'index-missing', 'schema-upgrade-required');
    failure(() => kb.leases.release('x'), 'index-missing', 'schema-upgrade-required');
    failure(() => kb.leases.list(), 'index-missing', 'schema-upgrade-required');
    assert.equal(rowsOf<{ user_version: number }>(dbPath, 'PRAGMA user_version')[0]!.user_version, 1);
    assert.deepEqual(rowsOf(dbPath, "SELECT name FROM sqlite_master WHERE name = 'generation_leases'"), []);
  });
});

interface Workspace {
  space: TempSpace;
  repo: string;
  config: string;
  dbPath: string;
}

function workspace(t: TestContext, retain = 5): Workspace {
  const space = tempSpace(t);
  const repo = makeRepo(space.path('repo'), { 'docs/a.md': doc('one') });
  const config = space.path('sources.yaml');
  writeFileSync(config, stringify({ schemaVersion: 1, database: { path: './k.sqlite' }, index: { retainGenerations: retain }, sources: [{ id: 'docs', project: 'docs', path: repo, include: ['docs/**/*.md'] }] }));
  return { space, repo, config, dbPath: space.path('k.sqlite') };
}

describe('library runIndex', () => {
  it('passes activate and lease through openKnowledgeBase', (t) => {
    const ws = workspace(t);
    const kb = openKnowledgeBase({ configPath: ws.config, retrievalConfigPath: RETRIEVAL_CONFIG_PATH });
    assert.equal(kb.runIndex({ onProgress: () => {} }).generation, 1);
    commit(ws.repo, { 'docs/a.md': doc('two') });
    const result = kb.runIndex({ onProgress: () => {}, activate: false, lease: { holder: 'kb', ttlSeconds: 600 } });
    assert.deepEqual([result.status, result.generation, result.lease?.generation, result.lease?.holder], ['published', 2, 2, 'kb']);
    assert.equal(kb.search(request()).index.generation, 1);
    assert.equal(kb.search(request({ generation: 2 })).index.generation, 2);
    assert.deepEqual(kb.leases.list('kb').map((lease) => lease.leaseId), [result.lease!.leaseId]);
  });
});

interface Run {
  status: number;
  stdout: string;
  doc: Record<string, any>;
}

function cli(args: readonly string[]): Run {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_KNOWLEDGE_')));
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(result.error, undefined);
  assert.equal(result.stdout.endsWith('\n'), true, result.stdout);
  assert.equal(result.stdout.trimEnd().includes('\n'), false, `expected one line: ${result.stdout}`);
  return { status: result.status!, stdout: result.stdout, doc: JSON.parse(result.stdout) as Record<string, any> };
}

function assertCliFailure(run: Run, code: ErrorCode, command: string | null, reason?: string): void {
  assert.equal(run.doc.schema, 'agent-knowledge.error', run.stdout);
  assert.equal(run.doc.ok, false);
  assert.equal(run.doc.command, command);
  assert.equal(run.doc.error.code, code, run.stdout);
  if (reason !== undefined) assert.equal(run.doc.error.detail.reason, reason, run.stdout);
  assert.equal(run.status, EXIT_CODES[code], run.stdout);
}

function assertLeaseDocument(run: Run, action: string, keys: string[]): void {
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(Object.keys(run.doc), ['schema', 'schemaVersion', 'ok', 'status', 'action', ...keys]);
  assert.deepEqual([run.doc.schema, run.doc.schemaVersion, run.doc.ok, run.doc.status, run.doc.action], ['agent-knowledge.lease', 1, true, 'ok', action]);
  assert.match(run.doc.indexId, INDEX_ID);
}

describe('lease CLI', () => {
  it('acquires, lists, renews and releases with the agent-knowledge.lease document', (t) => {
    const ws = workspace(t);
    assert.equal(cli(['index', '--config', ws.config, '--quiet']).status, 0);
    const base = ['--config', ws.config];

    const acquired = cli(['lease', 'acquire', ...base, '--holder', 'ci', '--ttl', '600']);
    assertLeaseDocument(acquired, 'acquire', ['indexId', 'lease']);
    const lease = acquired.doc.lease as Lease;
    assert.deepEqual([lease.generation, lease.holder, ttlOf(lease)], [1, 'ci', 600]);
    assert.match(lease.leaseId, UUID);
    assert.equal(acquired.doc.indexId, metaOf(ws.dbPath, 'index_id'));

    const listed = cli(['lease', 'list', ...base]);
    assertLeaseDocument(listed, 'list', ['indexId', 'leases']);
    assert.deepEqual(listed.doc.leases, [{ ...lease, expired: false }]);
    assert.deepEqual(cli(['lease', 'list', ...base, '--holder', 'other']).doc.leases, []);

    const renewed = cli(['lease', 'renew', ...base, '--lease-id', lease.leaseId, '--ttl', '1200']);
    assertLeaseDocument(renewed, 'renew', ['indexId', 'lease']);
    assert.equal(renewed.doc.lease.leaseId, lease.leaseId);
    assert.equal((Date.parse(renewed.doc.lease.expiresAt) - Date.parse(renewed.doc.lease.renewedAt)) / 1000, 1200);

    const released = cli(['lease', 'release', ...base, '--lease-id', lease.leaseId]);
    assertLeaseDocument(released, 'release', ['indexId', 'leaseId', 'released']);
    assert.deepEqual([released.doc.leaseId, released.doc.released], [lease.leaseId, true]);
    assert.equal(cli(['lease', 'release', ...base, '--lease-id', lease.leaseId]).doc.released, false);
  });

  it('reports usage for a missing or unknown action and for missing or malformed flags', (t) => {
    const ws = workspace(t);
    assert.equal(cli(['index', '--config', ws.config, '--quiet']).status, 0);
    const base = ['--config', ws.config];
    const missing = cli(['lease']);
    assertCliFailure(missing, 'usage', 'lease');
    assert.deepEqual(missing.doc.error.detail.actions, ['acquire', 'renew', 'release', 'list']);
    assertCliFailure(cli(['lease', 'extend', ...base]), 'usage', 'lease');
    assertCliFailure(cli(['lease', 'acquire', ...base]), 'usage', 'lease');
    assertCliFailure(cli(['lease', 'renew', ...base]), 'usage', 'lease');
    assertCliFailure(cli(['lease', 'acquire', ...base, '--holder', 'ci', '--ttl', 'soon']), 'usage', 'lease');
    assertCliFailure(cli(['lease', 'release', ...base, '--holder', 'ci']), 'usage', 'lease');
    assert.deepEqual(leaseRows(ws.dbPath), []);
  });

  it('maps lease failures to their error codes and does not create a missing database', (t) => {
    const ws = workspace(t);
    const missingDb = ws.space.path('nothing', 'k.sqlite');
    assertCliFailure(cli(['lease', 'acquire', '--config', ws.config, '--db', missingDb, '--holder', 'ci']), 'index-missing', 'lease', 'no-database');
    assert.equal(existsSync(missingDb), false);

    assert.equal(cli(['index', '--config', ws.config, '--quiet']).status, 0);
    const base = ['--config', ws.config];
    assertCliFailure(cli(['lease', 'acquire', ...base, '--holder', 'ci', '--ttl', '59']), 'invalid-request', 'lease', 'invalid-ttl');
    assertCliFailure(cli(['lease', 'acquire', ...base, '--holder', 'ci', '--generation', '99']), 'index-missing', 'lease', 'generation-not-found');
    assertCliFailure(cli(['lease', 'acquire', ...base, '--holder', 'ci', '--index-id', 'f'.repeat(32)]), 'index-missing', 'lease', 'index-id-mismatch');
    assertCliFailure(cli(['lease', 'renew', ...base, '--lease-id', 'nope']), 'not-found', 'lease', 'lease-not-found');
    assert.deepEqual(leaseRows(ws.dbPath), []);
  });

  it('publishes without activating and leases inside index', (t) => {
    const ws = workspace(t);
    const base = ['index', '--config', ws.config, '--quiet'];
    const first = cli(base);
    commit(ws.repo, { 'docs/a.md': doc('two') });
    const inactive = cli([...base, '--no-activate']);
    assert.equal(inactive.status, 0, inactive.stdout);
    assert.deepEqual(Object.keys(inactive.doc), Object.keys(first.doc));
    assert.deepEqual([inactive.doc.schemaVersion, inactive.doc.status, inactive.doc.generation], [1, 'published', 2]);
    assert.equal(metaOf(ws.dbPath, 'active_generation'), '1');

    commit(ws.repo, { 'docs/a.md': doc('three') });
    const leased = cli([...base, '--response-version', '2', '--no-activate', '--lease-holder', 'branch', '--lease-ttl', '600']);
    assert.equal(leased.status, 0, leased.stdout);
    assert.deepEqual([leased.doc.schemaVersion, leased.doc.status, leased.doc.generation, leased.doc.activated, leased.doc.activeGeneration], [2, 'published', 3, false, 1]);
    assert.deepEqual([leased.doc.lease.generation, leased.doc.lease.holder, ttlOf(leased.doc.lease as Lease)], [3, 'branch', 600]);
    assert.equal(leased.doc.indexId, metaOf(ws.dbPath, 'index_id'));
    assert.equal(cli([...base, '--response-version', '2']).doc.lease, null);

    const runs = runCount(ws.dbPath);
    const last = metaOf(ws.dbPath, 'last_generation');
    assertCliFailure(cli([...base, '--lease-holder', 'branch']), 'usage', 'index');
    assertCliFailure(cli([...base, '--response-version', '2', '--lease-ttl', '600']), 'usage', 'index');
    assertCliFailure(cli([...base, '--response-version', '2', '--lease-holder', 'branch', '--lease-ttl', '59']), 'invalid-request', 'index', 'invalid-ttl');
    assert.equal(runCount(ws.dbPath), runs);
    assert.equal(metaOf(ws.dbPath, 'last_generation'), last);
  });
});
