import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, type TestContext } from 'node:test';
import { KnowledgeError, type ErrorCode } from '../src/errors.js';
import { runIndex, type IndexResult, type ProgressEvent, type RunIndexOptions } from '../src/index.js';
import { REQUIRED_TABLES, SCHEMA_VERSION } from '../src/indexing/schema.js';
import { classifySchema, guardStore, openForRead, openForWrite, type Store } from '../src/indexing/store.js';
import { RESOLVER_VERSION } from '../src/parsing/versions.js';
import type { SourceConfig, SourcesConfig } from '../src/sources/config.js';
import { addIndexEntry, commit, commitRawNames, git, hashObject, makeRepo, tempSpace, writeFiles, type RepoFiles, type TempSpace } from './helpers.js';

function thrownBy(fn: () => unknown, code: ErrorCode): KnowledgeError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof KnowledgeError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

function sourceConfig(path: string, extra: Partial<SourceConfig> = {}): SourceConfig {
  return { id: 'src', project: 'proj', path, ref: 'HEAD', include: ['**/*.md'], exclude: [], defaultKind: 'reference', rules: [], maxFileBytes: 4096, ...extra };
}

function configOf(sources: SourceConfig[], retainGenerations = 5): SourcesConfig {
  return { schemaVersion: 1, configPath: 'x', database: { path: 'x' }, index: { retainGenerations, maxFileBytes: 4096 }, sources };
}

function index(store: Store, config: SourcesConfig, extra: Partial<RunIndexOptions> = {}): IndexResult {
  return runIndex({ config, store, onProgress: () => {}, ...extra });
}

function all<T>(db: DatabaseSync, sql: string, ...params: (string | number)[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function scalar(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return (db.prepare(sql).get(...params) as unknown as { value: number }).value;
}

/** FTS 그림자 테이블까지 포함해야 롤백이 정말 아무것도 남기지 않았는지 알 수 있다. */
function tableCounts(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { name } of all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'sqlite_sequence' ORDER BY name")) {
    counts[name] = scalar(db, `SELECT count(*) AS value FROM "${name}"`);
  }
  return counts;
}

function withoutRuns(counts: Record<string, number>): Record<string, number> {
  const { index_runs: _runs, ...rest } = counts;
  return rest;
}

function metaValue(db: DatabaseSync, key: string): number | null {
  const found = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as unknown as { value: string } | undefined;
  return found ? Number(found.value) : null;
}

function activeGeneration(db: DatabaseSync): number {
  return metaValue(db, 'active_generation')!;
}

function itemIds(db: DatabaseSync, generation = activeGeneration(db)): string[] {
  return all<{ id: string }>(db, 'SELECT i.item_id AS id FROM generation_items g JOIN items i ON i.item_pk = g.item_pk WHERE g.generation = ? ORDER BY 1', generation).map((row) => row.id);
}

function searchActive(db: DatabaseSync, term: string): string[] {
  return all<{ id: string }>(
    db,
    'SELECT i.item_id AS id FROM items_fts JOIN items i ON i.item_pk = items_fts.rowid JOIN generation_items g ON g.item_pk = i.item_pk WHERE items_fts MATCH ? AND g.generation = ? ORDER BY 1',
    `"${term}"`,
    activeGeneration(db),
  ).map((row) => row.id);
}

function lastRun(db: DatabaseSync): { status: string; generation: number | null; error_code: string | null; error_message: string | null; finished_at: string | null } {
  return all<ReturnType<typeof lastRun>>(db, 'SELECT status, generation, error_code, error_message, finished_at FROM index_runs ORDER BY run_id DESC LIMIT 1')[0]!;
}

function statusOf(db: DatabaseSync, itemId: string, generation = activeGeneration(db)): { base_status: string; effective_status: string; status_reason: string; links_json: string; conflicts_json: string } {
  return all<ReturnType<typeof statusOf>>(db, 'SELECT g.base_status, g.effective_status, g.status_reason, g.links_json, g.conflicts_json FROM generation_items g JOIN items i ON i.item_pk = g.item_pk WHERE g.generation = ? AND i.item_id = ?', generation, itemId)[0]!;
}

const body = (word: string): string => `# 제목\n\n${word} 본문입니다.\n`;
const A_ID = 'src:docs/a.md#제목';

interface Fixture {
  space: TempSpace;
  repo: string;
  store: Store;
  db: DatabaseSync;
  dbPath: string;
  config: SourcesConfig;
}

function setup(t: TestContext, files: RepoFiles = { 'docs/a.md': body('alpha') }, extra: Partial<SourceConfig> = {}, retain = 5): Fixture {
  const space = tempSpace(t);
  const repo = makeRepo(space.path('repo'), files);
  const dbPath = space.path('db', 'k.sqlite');
  const store = space.track(openForWrite(dbPath));
  return { space, repo, store, db: store.db, dbPath, config: configOf([sourceConfig(repo, extra)], retain) };
}

function makeForeignDatabase(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE someone_elses(a)');
  raw.close();
}

describe('store', () => {
  const SCHEMA = ['documents', 'generation_documents', 'generation_items', 'generation_sources', 'generations', 'index_runs', 'item_paths', 'items', 'items_fts', 'meta'];

  it('creates parent directories, the schema and write pragmas', (t) => {
    const space = tempSpace(t);
    const { db } = space.track(openForWrite(space.path('a', 'b', 'k.sqlite')));
    const names = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'items_fts_%' AND name <> 'sqlite_sequence' ORDER BY name").map((row) => row.name);
    assert.deepEqual(names, SCHEMA);
    assert.equal(scalar(db, 'SELECT user_version AS value FROM pragma_user_version'), SCHEMA_VERSION);
    assert.equal(scalar(db, 'SELECT foreign_keys AS value FROM pragma_foreign_keys'), 1);
    assert.equal(all<{ journal_mode: string }>(db, 'PRAGMA journal_mode')[0]!.journal_mode, 'wal');
  });

  it('reopens an existing database without migrating twice', (t) => {
    const space = tempSpace(t);
    const path = space.path('k.sqlite');
    openForWrite(path).close();
    const { db } = space.track(openForWrite(path));
    assert.equal(scalar(db, 'SELECT user_version AS value FROM pragma_user_version'), SCHEMA_VERSION);
  });

  it('classifies schema versions', () => {
    assert.equal(classifySchema(0, 0, 2), 'empty');
    assert.equal(classifySchema(0, 3, 2), 'foreign');
    assert.equal(classifySchema(1, 9, 2), 'older');
    assert.equal(classifySchema(2, 9, 2), 'current');
    assert.equal(classifySchema(3, 9, 2), 'newer');
  });

  it('reports an absent file as index-missing no-database', (t) => {
    const error = thrownBy(() => openForRead(tempSpace(t).path('none.sqlite')), 'index-missing');
    assert.equal((error.detail as { reason: string }).reason, 'no-database');
  });

  it('reports an empty database as index-missing no-generation', (t) => {
    const space = tempSpace(t);
    writeFileSync(space.path('empty.sqlite'), '');
    const error = thrownBy(() => openForRead(space.path('empty.sqlite')), 'index-missing');
    assert.equal((error.detail as { reason: string }).reason, 'no-generation');
  });

  for (const open of [openForRead, openForWrite]) {
    it(`${open.name} maps a garbage file to store-unavailable`, (t) => {
      const space = tempSpace(t);
      writeFileSync(space.path('garbage.sqlite'), 'not a database '.repeat(200));
      const error = thrownBy(() => open(space.path('garbage.sqlite')), 'store-unavailable');
      assert.deepEqual(error.detail, { errcode: 26, errstr: 'file is not a database' });
    });

    it(`${open.name} refuses a foreign database and a newer schema`, (t) => {
      const space = tempSpace(t);
      makeForeignDatabase(space.path('foreign.sqlite'));
      const unknown = thrownBy(() => open(space.path('foreign.sqlite')), 'store-unavailable');
      assert.equal((unknown.detail as { reason: string }).reason, 'unknown-database');

      const writer = openForWrite(space.path('newer.sqlite'));
      writer.db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
      writer.close();
      const newer = thrownBy(() => open(space.path('newer.sqlite')), 'store-unavailable');
      assert.equal((newer.detail as { reason: string }).reason, 'unsupported-schema');
    });
  }

  it('lists every table a fresh database has as required', (t) => {
    const { db } = setup(t);
    const tables = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'items_fts_%'").map((row) => row.name);
    assert.deepEqual(tables.sort(), [...REQUIRED_TABLES].sort());
  });

  for (const open of [openForRead, openForWrite]) {
    it(`${open.name} refuses a current-version database without the index tables`, (t) => {
      const space = tempSpace(t);
      const path = space.path('hollow.sqlite');
      const raw = new DatabaseSync(path);
      raw.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      raw.close();
      const error = thrownBy(() => open(path), 'store-unavailable');
      assert.equal((error.detail as { reason: string }).reason, 'unknown-database');
    });

    it(`${open.name} refuses an index that lost any required table`, (t) => {
      const space = tempSpace(t);
      for (const table of REQUIRED_TABLES) {
        const path = space.path(`lost-${table}.sqlite`);
        openForWrite(path).close();
        const raw = new DatabaseSync(path);
        raw.exec(`DROP TABLE ${table}`);
        raw.close();
        const error = thrownBy(() => open(path), 'store-unavailable');
        assert.equal((error.detail as { reason: string }).reason, 'unknown-database', table);
      }
    });
  }

  it('does not switch a foreign current-version database to WAL', (t) => {
    const space = tempSpace(t);
    const path = space.path('foreign-current.sqlite');
    const seed = new DatabaseSync(path);
    seed.exec(`CREATE TABLE other(a); PRAGMA user_version=${SCHEMA_VERSION}`);
    seed.close();
    thrownBy(() => openForWrite(path), 'store-unavailable');
    const raw = space.track(new DatabaseSync(path));
    assert.equal(all<{ journal_mode: string }>(raw, 'PRAGMA journal_mode')[0]!.journal_mode, 'delete');
    assert.deepEqual(all<{ name: string }>(raw, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name), ['other']);
  });

  it('leaves a foreign database untouched when refusing it', (t) => {
    const space = tempSpace(t);
    const path = space.path('foreign.sqlite');
    makeForeignDatabase(path);
    thrownBy(() => openForWrite(path), 'store-unavailable');
    const raw = space.track(new DatabaseSync(path));
    assert.equal(all<{ journal_mode: string }>(raw, 'PRAGMA journal_mode')[0]!.journal_mode, 'delete');
    assert.deepEqual(all<{ name: string }>(raw, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name), ['someone_elses']);
  });

  it('maps SQLite errors by primary code and passes others through', () => {
    const sqlite = (errcode: number) => Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR', errcode, errstr: 'text' });
    for (const code of [5, 6, 8, 10, 11, 13, 14, 26, 261, 526, 1038]) {
      const error = thrownBy(() => guardStore(() => { throw sqlite(code); }), 'store-unavailable');
      assert.deepEqual(error.detail, { errcode: code, errstr: 'text' });
    }
    for (const code of [1, 19, 1555]) thrownBy(() => guardStore(() => { throw sqlite(code); }), 'internal-error');
    const original = new KnowledgeError('not-found', 'x');
    assert.throws(() => guardStore(() => { throw original; }), (error) => error === original);
    const plain = new TypeError('plain');
    assert.throws(() => guardStore(() => { throw plain; }), (error) => error === plain);
    assert.equal(guardStore(() => 7), 7);
  });

  it('maps a real syntax error to internal-error and a write on a read-only store to store-unavailable', (t) => {
    const space = tempSpace(t);
    const path = space.path('k.sqlite');
    openForWrite(path).close();
    const reader = space.track(openForRead(path));
    thrownBy(() => reader.read((db) => db.exec('SELEC 1')), 'internal-error');
    const error = thrownBy(() => reader.read((db) => db.exec("INSERT INTO meta VALUES('a','b')")), 'store-unavailable');
    assert.equal((error.detail as { errcode: number }).errcode & 0xff, 8);
    assert.equal(reader.db.isTransaction, false);
  });

  it('serves every read of one call from the same snapshot', (t) => {
    const space = tempSpace(t);
    const path = space.path('k.sqlite');
    const writer = space.track(openForWrite(path));
    writer.db.exec("INSERT INTO meta VALUES('a','1')");
    const reader = space.track(openForRead(path));
    const count = (db: DatabaseSync): number => scalar(db, 'SELECT count(*) AS value FROM meta');
    const seen = reader.read((db) => {
      const first = count(db);
      writer.db.exec("INSERT INTO meta VALUES('b','2')");
      return [first, count(db)];
    });
    assert.deepEqual(seen, [1, 1]);
    assert.equal(reader.read(count), 2);
  });
});

describe('runIndex publishing', () => {
  it('publishes a first generation with versions, commits and status', (t) => {
    const { repo, store, db, config } = setup(t, {
      'docs/a.md': '# 제목\n\nalpha 본문입니다.\n\n### `BR-1` 규칙\n- 상태: 관찰\n- 코드: src/a.ts\n\n내용\n',
      'src/a.ts': 'export {};\n',
      'notes.txt': 'not markdown',
    });
    const head = git(repo, ['rev-parse', 'HEAD']);
    const result = index(store, config);

    assert.equal(result.status, 'published');
    assert.equal(result.generation, 1);
    assert.equal(result.documentCount, 1);
    assert.equal(result.itemCount, 2);
    assert.deepEqual(result.sources, [{ sourceId: 'src', projectId: 'proj', requestedRef: 'HEAD', commit: head, documentCount: 1, added: 1, reused: 0, removed: 0, skipped: [] }]);

    assert.equal(activeGeneration(db), 1);
    assert.equal(metaValue(db, 'last_generation'), 1);
    const generation = all<Record<string, unknown>>(db, 'SELECT * FROM generations')[0]!;
    assert.equal(generation.resolver_version, RESOLVER_VERSION);
    assert.equal(generation.document_count, 1);
    assert.equal(generation.item_count, 2);
    assert.equal(generation.run_id, result.runId);
    assert.deepEqual(all<Record<string, unknown>>(db, 'SELECT source_id, project_id, requested_ref, commit_sha, document_count FROM generation_sources').map((row) => ({ ...row })), [
      { source_id: 'src', project_id: 'proj', requested_ref: 'HEAD', commit_sha: head, document_count: 1 },
    ]);

    assert.deepEqual(itemIds(db), ['src:docs/a.md#BR-1', A_ID]);
    assert.deepEqual(searchActive(db, 'alpha'), [A_ID]);
    assert.deepEqual(all<Record<string, string>>(db, 'SELECT relation, path FROM item_paths').map((row) => ({ ...row })), [{ relation: 'code', path: 'src/a.ts' }]);
    const entry = statusOf(db, 'src:docs/a.md#BR-1');
    assert.deepEqual([entry.base_status, entry.effective_status, entry.status_reason], ['observed_behavior', 'observed_behavior', 'code-reference-resolved']);
    assert.deepEqual(JSON.parse(entry.links_json), [{ relation: 'code', target: 'src/a.ts', resolved: true, kind: 'path' }]);
    assert.deepEqual({ ...lastRun(db), finished_at: null }, { status: 'published', generation: 1, error_code: null, error_message: null, finished_at: null });
    assert.ok(lastRun(db).finished_at);
  });

  it('adds no generation and no rows on an unchanged re-run', (t) => {
    const { store, db, config } = setup(t, { 'docs/a.md': body('alpha'), 'docs/big.md': 'x'.repeat(5000) });
    const first = index(store, config);
    const before = tableCounts(db);
    const again = index(store, config);
    assert.equal(again.status, 'unchanged');
    assert.equal(again.generation, 1);
    assert.equal(again.documentCount, first.documentCount);
    assert.equal(again.itemCount, first.itemCount);
    assert.deepEqual(again.sources, [{ ...first.sources[0]!, added: 0, reused: 1, removed: 0 }]);
    assert.deepEqual(withoutRuns(tableCounts(db)), withoutRuns(before));
    assert.equal(tableCounts(db).index_runs, before.index_runs! + 1);
    assert.deepEqual({ status: lastRun(db).status, generation: lastRun(db).generation }, { status: 'unchanged', generation: 1 });
  });

  it('reflects a modified document and reuses the untouched one', (t) => {
    const { repo, store, db, config } = setup(t, { 'docs/a.md': body('alpha'), 'docs/b.md': body('bravo') });
    index(store, config);
    const untouched = all(db, 'SELECT document_pk FROM documents WHERE path = ?', 'docs/b.md');
    commit(repo, { 'docs/a.md': body('changed') });
    const result = index(store, config);
    assert.deepEqual([result.status, result.generation], ['published', 2]);
    assert.deepEqual([result.sources[0]!.added, result.sources[0]!.reused, result.sources[0]!.removed], [1, 1, 1]);
    assert.deepEqual(searchActive(db, 'changed'), [A_ID]);
    assert.deepEqual(searchActive(db, 'alpha'), []);
    assert.deepEqual(all(db, 'SELECT document_pk FROM documents WHERE path = ?', 'docs/b.md'), untouched);
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM generation_documents WHERE generation = 2'), 2);
  });

  it('drops a deleted document from the new generation only', (t) => {
    const { repo, store, db, config } = setup(t, { 'docs/a.md': body('alpha'), 'docs/b.md': body('bravo') });
    index(store, config);
    commit(repo, { 'docs/b.md': null });
    const result = index(store, config);
    assert.deepEqual([result.sources[0]!.added, result.sources[0]!.reused, result.sources[0]!.removed], [0, 1, 1]);
    assert.deepEqual(itemIds(db), [A_ID]);
    assert.deepEqual(searchActive(db, 'bravo'), []);
    assert.deepEqual(itemIds(db, 1), [A_ID, 'src:docs/b.md#제목']);
  });

  it('follows a rename as a removal and an addition', (t) => {
    const { repo, store, db, config } = setup(t);
    index(store, config);
    git(repo, ['mv', 'docs/a.md', 'docs/renamed.md']);
    commit(repo, {});
    const result = index(store, config);
    assert.deepEqual([result.sources[0]!.added, result.sources[0]!.removed], [1, 1]);
    assert.deepEqual(itemIds(db), ['src:docs/renamed.md#제목']);
    assert.deepEqual(searchActive(db, 'alpha'), ['src:docs/renamed.md#제목']);
  });

  it('adds a new document', (t) => {
    const { repo, store, db, config } = setup(t);
    index(store, config);
    commit(repo, { 'docs/new.md': body('newcomer') });
    const result = index(store, config);
    assert.deepEqual([result.sources[0]!.added, result.sources[0]!.reused, result.sources[0]!.removed], [1, 1, 0]);
    assert.deepEqual(searchActive(db, 'newcomer'), ['src:docs/new.md#제목']);
  });

  it('indexes the pinned commit and ignores later commits and the working tree', (t) => {
    const { repo, store, db } = setup(t);
    const pinned = git(repo, ['rev-parse', 'HEAD']);
    commit(repo, { 'docs/a.md': body('later') });
    writeFiles(repo, { 'docs/a.md': body('dirty'), 'docs/untracked.md': body('untracked') });
    const result = index(store, configOf([sourceConfig(repo, { ref: pinned })]));
    assert.equal(result.sources[0]!.commit, pinned);
    assert.deepEqual(searchActive(db, 'alpha'), [A_ID]);
    assert.deepEqual(searchActive(db, 'later'), []);
    assert.deepEqual(searchActive(db, 'dirty'), []);
    assert.deepEqual(searchActive(db, 'untracked'), []);
  });

  it('reads HEAD, not uncommitted changes', (t) => {
    const { repo, store, db, config } = setup(t);
    writeFiles(repo, { 'docs/a.md': body('dirty') });
    index(store, config);
    assert.deepEqual(searchActive(db, 'alpha'), [A_ID]);
    assert.deepEqual(searchActive(db, 'dirty'), []);
  });

  it('honors a ref override and refuses an unknown source id', (t) => {
    const { repo, store, db, config } = setup(t);
    const tagged = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['tag', 'v1']);
    commit(repo, { 'docs/a.md': body('later') });
    const result = index(store, config, { refOverrides: new Map([['src', 'v1']]) });
    assert.deepEqual([result.sources[0]!.requestedRef, result.sources[0]!.commit], ['v1', tagged]);
    assert.deepEqual(searchActive(db, 'alpha'), [A_ID]);
    assert.deepEqual(all<{ r: string }>(db, 'SELECT requested_ref AS r FROM generation_sources').map((row) => row.r), ['v1']);

    const error = thrownBy(() => index(store, config, { refOverrides: new Map([['nope', 'v1']]) }), 'source-unavailable');
    assert.deepEqual(error.detail, { reason: 'unknown-source', sourceId: 'nope' });
    assert.equal(activeGeneration(db), 1);
  });

  it('records one commit per repository', (t) => {
    const space = tempSpace(t);
    const one = makeRepo(space.path('one'), { 'a.md': body('alpha') });
    const two = makeRepo(space.path('two'), { 'b.md': body('bravo') });
    const store = space.track(openForWrite(space.path('k.sqlite')));
    const result = index(store, configOf([sourceConfig(two, { id: 'zeta', project: 'p2' }), sourceConfig(one, { id: 'beta', project: 'p1' })]));
    const expected = [
      ['beta', 'p1', git(one, ['rev-parse', 'HEAD'])],
      ['zeta', 'p2', git(two, ['rev-parse', 'HEAD'])],
    ];
    assert.deepEqual(result.sources.map((source) => [source.sourceId, source.projectId, source.commit]), expected);
    assert.deepEqual(all<{ s: string; p: string; c: string }>(store.db, 'SELECT source_id AS s, project_id AS p, commit_sha AS c FROM generation_sources ORDER BY 1').map((row) => [row.s, row.p, row.c]), expected);
  });

  it('recomputes generation-dependent status for a reused document', (t) => {
    const { repo, store, db, config } = setup(t, { 'docs/a.md': '# 제목\n\n- 상태: 관찰\n- 코드: src/a.ts\n\n본문\n' });
    index(store, config);
    assert.equal(statusOf(db, A_ID).base_status, 'unverified');
    commit(repo, { 'src/a.ts': 'export {};\n' });
    const result = index(store, config);
    assert.equal(result.sources[0]!.reused, 1);
    assert.equal(statusOf(db, A_ID).base_status, 'observed_behavior');
    assert.equal(statusOf(db, A_ID, 1).base_status, 'unverified');
  });

  it('checks commit references for new and reused documents against the repository', (t) => {
    const { repo, store, db, config } = setup(t, { 'docs/seed.md': body('seed') });
    const sha = git(repo, ['rev-parse', 'HEAD']);
    commit(repo, { 'docs/a.md': `# 제목\n\n- 상태: 검증됨\n- 근거: commit:${sha}\n\n본문\n`, 'docs/b.md': '# 둘\n\n- 상태: 검증됨\n- 근거: commit:deadbee\n\n본문\n' });
    index(store, config);
    assert.equal(statusOf(db, A_ID).base_status, 'verified_experience');
    assert.equal(statusOf(db, 'src:docs/b.md#둘').status_reason, 'status-basis-unresolved');
    commit(repo, { 'docs/seed.md': body('seed2') });
    assert.equal(index(store, config).sources[0]!.reused, 2);
    assert.equal(statusOf(db, A_ID).base_status, 'verified_experience');
  });

  it('reports document diagnostics to the progress channel as source:path code', (t) => {
    const { repo, store, config } = setup(t, { 'docs/a.md': '---\nkind: nonsense\n---\n# 제목\n\n본문\n' });
    const seen: string[] = [];
    const onProgress: RunIndexOptions['onProgress'] = (event) => {
      if (event.stage === 'diagnostic') seen.push(event.message);
    };
    index(store, config, { onProgress });
    assert.deepEqual(seen, ['src:docs/a.md unknown-kind']);
    commit(repo, { 'docs/b.md': body('bravo') });
    seen.length = 0;
    index(store, config, { onProgress });
    assert.deepEqual(seen, ['src:docs/a.md unknown-kind']);
  });
});

describe('runIndex failure handling', () => {
  it('rolls everything back when beforePublish throws', (t) => {
    const { repo, store, db, dbPath, config, space } = setup(t);
    index(store, config);
    commit(repo, { 'docs/a.md': body('changed'), 'docs/new.md': body('newcomer') });
    const before = tableCounts(db);
    const counts: Record<string, number>[] = [];
    const seen: number[] = [];

    const error = thrownBy(
      () =>
        index(store, config, {
          hooks: {
            beforePublish(generation) {
              seen.push(generation);
              counts.push(tableCounts(db));
              throw new Error('boom');
            },
          },
        }),
      'index-failed',
    );

    assert.deepEqual(error.detail, { cause: { code: 'internal-error', message: 'boom' } });
    assert.deepEqual(seen, [2]);
    // 훅 시점에 행이 실제로 들어갔어야 롤백 검증이 의미를 가진다
    assert.equal(counts[0]!.generations, before.generations! + 1);
    assert.ok(counts[0]!.items! > before.items!);
    assert.ok(counts[0]!.items_fts! > before.items_fts!);
    assert.deepEqual(withoutRuns(tableCounts(db)), withoutRuns(before));
    assert.equal(db.isTransaction, false);

    assert.equal(activeGeneration(db), 1);
    assert.equal(metaValue(db, 'last_generation'), 1);
    assert.deepEqual(searchActive(db, 'alpha'), [A_ID]);
    assert.deepEqual(searchActive(db, 'changed'), []);
    const reader = space.track(openForRead(dbPath));
    assert.deepEqual(reader.read((read) => itemIds(read)), [A_ID]);
    assert.deepEqual({ status: lastRun(db).status, code: lastRun(db).error_code, message: lastRun(db).error_message }, { status: 'failed', code: 'index-failed', message: error.message });

    const retried = index(store, config);
    assert.deepEqual([retried.status, retried.generation], ['published', 2]);
    assert.deepEqual(searchActive(db, 'changed'), [A_ID]);
  });

  it('wraps a KnowledgeError from the transaction with its inner code', (t) => {
    const { store, config } = setup(t);
    const error = thrownBy(
      () => index(store, config, { hooks: { beforePublish() { throw new KnowledgeError('not-found', 'inner'); } } }),
      'index-failed',
    );
    assert.deepEqual(error.detail, { cause: { code: 'not-found', message: 'inner' } });
  });

  it('aborts every source when one is bad and keeps the old generation', (t) => {
    const { space, repo, store, db } = setup(t);
    const good = sourceConfig(repo);
    index(store, configOf([good]));
    commit(repo, { 'docs/a.md': body('changed') });
    const before = tableCounts(db);
    const error = thrownBy(() => index(store, configOf([good, sourceConfig(space.path('missing'), { id: 'zzz' })])), 'source-unavailable');
    assert.equal((error.detail as { command: string }).command, 'rev-parse');
    assert.deepEqual(withoutRuns(tableCounts(db)), withoutRuns(before));
    assert.equal(activeGeneration(db), 1);
    assert.deepEqual(searchActive(db, 'alpha'), [A_ID]);
    assert.equal(lastRun(db).status, 'failed');
    assert.equal(lastRun(db).error_code, 'source-unavailable');
  });

  it('keeps the active generation when a source is a subdirectory of a repository', (t) => {
    const { repo, store, db, config } = setup(t, { 'docs/a.md': body('alpha'), 'sub/b.md': body('beta') });
    index(store, config);
    commit(repo, { 'docs/a.md': body('changed') });
    const before = tableCounts(db);
    const error = thrownBy(() => index(store, configOf([sourceConfig(join(repo, 'sub'))])), 'source-unavailable');
    assert.equal((error.detail as { reason: string }).reason, 'not-git-toplevel');
    assert.deepEqual(withoutRuns(tableCounts(db)), withoutRuns(before));
    assert.equal(activeGeneration(db), 1);
    assert.equal(lastRun(db).error_code, 'source-unavailable');
  });

  it('fails a first run with no generation left behind', (t) => {
    const { space, store, db } = setup(t);
    thrownBy(() => index(store, configOf([sourceConfig(space.path('missing'))])), 'source-unavailable');
    assert.equal(metaValue(db, 'active_generation'), null);
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM generations'), 0);
  });

  it('raises index-conflict when another run publishes during parsing', (t) => {
    const { space, repo, store, db, dbPath, config } = setup(t);
    index(store, config);
    commit(repo, { 'docs/a.md': body('changed') });
    const other = space.track(openForWrite(dbPath));
    let countsAfterOther: Record<string, number> | undefined;
    const onProgress: RunIndexOptions['onProgress'] = (event) => {
      if (event.stage === 'parse' && !countsAfterOther) {
        assert.equal(index(other, config).generation, 2);
        countsAfterOther = tableCounts(db);
      }
    };

    const error = thrownBy(() => index(store, config, { onProgress }), 'index-conflict');
    assert.deepEqual(error.detail, { expectedActive: 1 });
    assert.equal(activeGeneration(db), 2);
    assert.deepEqual(withoutRuns(tableCounts(db)), withoutRuns(countsAfterOther!));
    // 바깥 실행이 먼저 시작했으므로 실패 행은 마지막 행이 아니다
    assert.deepEqual(all<{ c: string }>(db, "SELECT error_code AS c FROM index_runs WHERE status = 'failed'").map((row) => row.c), ['index-conflict']);
  });

  it('reports a locked store as index-failed and keeps that error when the run cannot be recorded', (t) => {
    const { space, repo, store, db, dbPath, config } = setup(t);
    index(store, config);
    commit(repo, { 'docs/a.md': body('changed') });
    const blocker = space.track(openForWrite(dbPath));
    db.exec('PRAGMA busy_timeout=0');
    const onProgress: RunIndexOptions['onProgress'] = (event) => {
      if (event.stage === 'publish') blocker.db.exec('BEGIN IMMEDIATE');
    };
    const error = thrownBy(() => index(store, config, { onProgress }), 'index-failed');
    assert.equal((error.detail as { cause: { code: string } }).cause.code, 'store-unavailable');
    blocker.db.exec('ROLLBACK');
    assert.equal(lastRun(db).status, 'running');
    assert.equal(activeGeneration(db), 1);
  });
});

describe('runIndex retention', () => {
  it('collects generations beyond the limit along with their rows', (t) => {
    const { repo, store, db, config } = setup(
      t,
      { 'docs/a.md': '# 제목\n\nalpha 본문\n\n- 코드: src/x.ts\n', 'docs/keep.md': body('keeper') },
      {},
      2,
    );
    index(store, config);
    commit(repo, { 'docs/a.md': '# 제목\n\nbravo 본문\n\n- 코드: src/y.ts\n' });
    index(store, config);
    commit(repo, { 'docs/a.md': '# 제목\n\ncharlie 본문\n\n- 코드: src/z.ts\n' });
    const result = index(store, config);

    assert.equal(result.generation, 3);
    assert.deepEqual(all<{ g: number }>(db, 'SELECT generation AS g FROM generations ORDER BY 1').map((row) => row.g), [2, 3]);
    for (const table of ['generation_sources', 'generation_documents', 'generation_items']) {
      assert.equal(scalar(db, `SELECT count(*) AS value FROM ${table} WHERE generation = 1`), 0, table);
    }
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM documents'), 3, 'keep.md는 공유되고 a.md 두 판이 남는다');
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM items'), 3);
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM items_fts'), 3);
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM documents WHERE document_pk NOT IN (SELECT document_pk FROM generation_documents)'), 0);
    assert.equal(all(db, 'SELECT rowid FROM items_fts WHERE items_fts MATCH ?', '"alpha"').length, 0);
    assert.equal(all(db, 'SELECT rowid FROM items_fts WHERE items_fts MATCH ?', '"bravo"').length, 1);
    assert.deepEqual(all<{ path: string }>(db, 'SELECT path FROM item_paths ORDER BY 1').map((row) => row.path), ['src/y.ts', 'src/z.ts']);
    assert.equal(all(db, 'PRAGMA foreign_key_check').length, 0);
  });

  it('keeps generation numbers monotonic across collection', (t) => {
    const { repo, store, db, config } = setup(t, undefined, {}, 1);
    index(store, config);
    commit(repo, { 'docs/a.md': body('second') });
    index(store, config);
    assert.deepEqual(all<{ g: number }>(db, 'SELECT generation AS g FROM generations').map((row) => row.g), [2]);
    commit(repo, { 'docs/a.md': body('third') });
    assert.equal(index(store, config).generation, 3);
    assert.equal(metaValue(db, 'last_generation'), 3);
    assert.equal(tableCounts(db).documents, 1);
  });

  it('keeps a document row a retained generation still needs', (t) => {
    const { repo, store, db, config } = setup(t, undefined, {}, 2);
    index(store, config);
    commit(repo, { 'docs/a.md': body('second') });
    index(store, config);
    commit(repo, { 'docs/a.md': body('alpha') });
    index(store, config);
    assert.deepEqual(itemIds(db, 2), [A_ID]);
    assert.deepEqual(itemIds(db, 3), [A_ID]);
    assert.equal(tableCounts(db).documents, 2);
  });

  it('applies a lowered retention on an unchanged run', (t) => {
    const { repo, store, db, config } = setup(t);
    index(store, config);
    commit(repo, { 'docs/a.md': body('bravo') });
    index(store, config);
    commit(repo, { 'docs/a.md': body('charlie') });
    index(store, config);
    assert.deepEqual(all<{ g: number }>(db, 'SELECT generation AS g FROM generations ORDER BY 1').map((row) => row.g), [1, 2, 3]);

    const result = index(store, { ...config, index: { ...config.index, retainGenerations: 1 } });
    assert.equal(result.status, 'unchanged');
    assert.equal(result.generation, 3);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(all<{ g: number }>(db, 'SELECT generation AS g FROM generations ORDER BY 1').map((row) => row.g), [3]);
    assert.equal(metaValue(db, 'active_generation'), 3);
    assert.equal(lastRun(db).status, 'unchanged');
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM documents'), 1);
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM items_fts'), 1);
    assert.equal(all(db, 'SELECT rowid FROM items_fts WHERE items_fts MATCH ?', '"alpha"').length, 0);
    assert.equal(all(db, 'PRAGMA foreign_key_check').length, 0);
    assert.deepEqual(itemIds(db), [A_ID]);
  });

  it('keeps every generation on an unchanged run within the limit', (t) => {
    const { repo, store, db, config } = setup(t);
    index(store, config);
    commit(repo, { 'docs/a.md': body('bravo') });
    index(store, config);
    const result = index(store, { ...config, index: { ...config.index, retainGenerations: 2 } });
    assert.equal(result.status, 'unchanged');
    assert.deepEqual(all<{ g: number }>(db, 'SELECT generation AS g FROM generations ORDER BY 1').map((row) => row.g), [1, 2]);
    assert.equal(tableCounts(db).documents, 2);
  });
});

describe('runIndex empty sources', () => {
  const diagnosticsOf = (events: readonly ProgressEvent[]): string[] => events.filter((event) => event.stage === 'diagnostic').map((event) => event.message);

  it('warns about a source that matches no documents and still publishes, also when unchanged', (t) => {
    const { store, config } = setup(t, undefined, { include: ['nowhere/**/*.md'] });
    const events: ProgressEvent[] = [];
    const published = index(store, config, { onProgress: (event) => events.push(event) });
    assert.equal(published.status, 'published');
    assert.equal(published.documentCount, 0);
    assert.equal(diagnosticsOf(events).length, 1);
    assert.match(diagnosticsOf(events)[0]!, /^src no-matching-documents/);

    events.length = 0;
    assert.equal(index(store, config, { onProgress: (event) => events.push(event) }).status, 'unchanged');
    assert.equal(diagnosticsOf(events).length, 1);
  });

  it('warns once for each empty source and not for a source with documents', (t) => {
    const { space, repo, store } = setup(t);
    const other = makeRepo(space.path('other'), { 'docs/b.md': body('other') });
    const config = configOf([
      sourceConfig(repo, { id: 'full' }),
      sourceConfig(repo, { id: 'typo', include: ['nowhere/**/*.md'] }),
      sourceConfig(other, { id: 'typo-too', project: 'other', include: ['nowhere/**/*.md'] }),
    ]);
    const events: ProgressEvent[] = [];
    assert.equal(index(store, config, { onProgress: (event) => events.push(event) }).documentCount, 1);
    assert.deepEqual(diagnosticsOf(events).map((message) => message.split(':')[0]), ['typo no-matching-documents', 'typo-too no-matching-documents']);
  });
});

describe('runIndex document selection', () => {
  it('reports blocked, too-large and undecodable documents without indexing them', (t) => {
    const { store, db, config } = setup(
      t,
      {
        'docs/a.md': body('alpha'),
        'docs/.env.md': body('blocked'),
        'docs/secret.md': body('blocked'),
        'docs/big.md': 'x'.repeat(5000),
        'docs/latin.md': Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]),
        'docs/zero.md': Buffer.from([0x23, 0x00, 0x0a]),
      },
      {},
    );
    const result = index(store, config);
    const expected = [
      { path: 'docs/.env.md', reason: 'blocked-path' },
      { path: 'docs/big.md', reason: 'too-large' },
      { path: 'docs/latin.md', reason: 'not-utf8' },
      { path: 'docs/secret.md', reason: 'blocked-path' },
      { path: 'docs/zero.md', reason: 'binary' },
    ];
    assert.deepEqual(result.sources[0]!.skipped, expected);
    assert.equal(result.documentCount, 1);
    assert.deepEqual(JSON.parse(all<{ s: string }>(db, 'SELECT skipped_json AS s FROM generation_sources')[0]!.s), expected);
    assert.deepEqual(all<{ path: string }>(db, 'SELECT path FROM documents').map((row) => row.path), ['docs/a.md']);
    assert.deepEqual(searchActive(db, 'blocked'), []);
    assert.deepEqual(index(store, config).sources[0]!.skipped, expected);
  });

  it('never reads symlinks or submodules and does not resolve code links to them', (t) => {
    const { repo, store, db, config } = setup(t, { 'docs/a.md': '# 제목\n\n- 상태: 관찰\n- 코드: vendor/sub\n\n본문\n' });
    const head = git(repo, ['rev-parse', 'HEAD']);
    addIndexEntry(repo, '120000', hashObject(repo, '# linked secret\n'), 'docs/link.md');
    addIndexEntry(repo, '160000', head, 'vendor/sub');
    git(repo, ['commit', '-m', 'special']);
    const result = index(store, config);
    assert.equal(result.documentCount, 1);
    assert.deepEqual(result.sources[0]!.skipped, []);
    assert.deepEqual(all<{ path: string }>(db, 'SELECT path FROM documents').map((row) => row.path), ['docs/a.md']);
    assert.equal(searchActive(db, 'linked').length, 0);
    assert.equal(statusOf(db, A_ID).base_status, 'unverified');
  });

  for (const [mode, target] of [['120000', 'docs/link.md'], ['160000', 'vendor/sub']] as const) {
    it(`does not confirm an item from a mode ${mode} basis`, (t) => {
      const { repo, store, db, config } = setup(t, { 'docs/a.md': `# 제목\n\n- 상태: 확정\n- 근거: ${target}\n\n본문\n` });
      addIndexEntry(repo, mode, mode === '160000' ? git(repo, ['rev-parse', 'HEAD']) : hashObject(repo, 'somewhere'), target);
      git(repo, ['commit', '-m', 'special']);
      index(store, config);
      assert.equal(statusOf(db, A_ID).base_status, 'unverified');
    });
  }

  it('skips undecodable file names without failing or inventing a path', (t) => {
    const space = tempSpace(t);
    const repo = makeRepo(space.path('repo'));
    commitRawNames(repo, [
      { name: 'docs/a.md', content: body('alpha') },
      { name: Buffer.from('docs/caf\xe9.md', 'latin1'), content: body('same') },
      { name: Buffer.from('docs/caf\xe8.md', 'latin1'), content: body('same') },
    ]);
    const store = space.track(openForWrite(space.path('db', 'k.sqlite')));
    const result = index(store, configOf([sourceConfig(repo)]));
    assert.equal(result.status, 'published');
    assert.deepEqual(result.sources[0]!.skipped, [
      { path: 'docs/caf\\xe8.md', reason: 'not-utf8-path' },
      { path: 'docs/caf\\xe9.md', reason: 'not-utf8-path' },
    ]);
    assert.deepEqual(all<{ path: string }>(store.db, 'SELECT path FROM documents').map((row) => row.path), ['docs/a.md']);
  });

  it('reparses when the stored parser version differs', (t) => {
    const { store, db, config } = setup(t);
    index(store, config);
    // 버전 상수는 바꿀 수 없으므로 이전 파서가 만든 색인과 같은 상태를 DB에 직접 만든다
    const current = all<{ f: string }>(db, 'SELECT parse_fingerprint AS f FROM documents')[0]!.f;
    db.exec("UPDATE documents SET parse_fingerprint = 'previous-parser'");
    db.exec("UPDATE generations SET fingerprint = 'previous-parser', parser_version = 'md-0'");

    const result = index(store, config);
    assert.deepEqual([result.status, result.generation, result.sources[0]!.added, result.sources[0]!.reused, result.sources[0]!.removed], ['published', 2, 1, 0, 1]);
    assert.deepEqual(all<{ f: string; g: number }>(db, 'SELECT parse_fingerprint AS f, first_generation AS g FROM documents ORDER BY document_pk').map((row) => [row.f, row.g]), [['previous-parser', 1], [current, 2]]);
    assert.deepEqual(itemIds(db), [A_ID]);
  });

  it('publishes a new generation when maxFileBytes changes and picks up newly allowed files', (t) => {
    const { repo, store, db } = setup(t, { 'docs/a.md': body('alpha'), 'docs/big.md': `${body('huge')}${'x'.repeat(3000)}\n` });
    const small = configOf([sourceConfig(repo, { maxFileBytes: 1000 })]);
    assert.equal(index(store, small).sources[0]!.skipped.length, 1);

    const large = configOf([sourceConfig(repo, { maxFileBytes: 4096 })]);
    const result = index(store, large);
    assert.deepEqual([result.status, result.generation], ['published', 2]);
    assert.deepEqual([result.sources[0]!.added, result.sources[0]!.reused, result.sources[0]!.skipped.length], [1, 1, 0]);
    assert.deepEqual(searchActive(db, 'huge'), ['src:docs/big.md#제목']);
  });

  it('publishes when include or rules change even at the same commit', (t) => {
    const { repo, store, db } = setup(t, { 'docs/a.md': body('alpha'), 'other/b.md': body('bravo') });
    index(store, configOf([sourceConfig(repo, { include: ['docs/**'] })]));
    const result = index(store, configOf([sourceConfig(repo, { include: ['**/*.md'] })]));
    assert.deepEqual([result.status, result.generation, result.sources[0]!.added, result.sources[0]!.reused], ['published', 2, 1, 1]);

    const ruled = index(store, configOf([sourceConfig(repo, { include: ['**/*.md'], rules: [{ match: 'docs/a.md', status: 'confirmed_policy', basis: '운영자 확인' }] })]));
    assert.deepEqual([ruled.status, ruled.sources[0]!.added, ruled.sources[0]!.reused, ruled.sources[0]!.removed], ['published', 1, 1, 1]);
    assert.equal(statusOf(db, A_ID).base_status, 'confirmed_policy');
    assert.equal(statusOf(db, A_ID).status_reason, 'source-rule');
  });

  it('counts zero-item documents exactly once and reuses them', (t) => {
    const { repo, store, db, config } = setup(t, { 'docs/a.md': body('alpha'), 'docs/empty.md': '', 'docs/also-empty.md': '', 'docs/headings.md': '# 제목\n\n## 둘\n' });
    const result = index(store, config);
    assert.equal(result.documentCount, 4);
    assert.equal(result.itemCount, 1);
    assert.equal(result.sources[0]!.documentCount, 4);
    assert.equal(tableCounts(db).documents, 4);
    assert.equal(tableCounts(db).generation_documents, 4);
    assert.equal(tableCounts(db).items, 1);
    assert.equal(all<{ d: number; i: number }>(db, 'SELECT document_count AS d, item_count AS i FROM generations').map((row) => row.d + row.i)[0], 5);

    commit(repo, { 'docs/a.md': body('changed') });
    const next = index(store, config);
    assert.deepEqual([next.documentCount, next.itemCount, next.sources[0]!.added, next.sources[0]!.reused, next.sources[0]!.removed], [4, 1, 1, 3, 1]);
    assert.equal(tableCounts(db).documents, 5);
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM generation_documents WHERE generation = 2'), 4);
  });

  it('leaves ambiguous references unresolved and lists sorted candidates', (t) => {
    const entry = (key: string, extra = ''): string => `# 제목\n\n### \`${key}\` 규칙\n${extra}\n본문\n`;
    const space = tempSpace(t);
    const one = makeRepo(space.path('one'), {
      'docs/z.md': entry('BR-1'),
      'docs/b.md': entry('BR-1'),
      'docs/x.md': body('alpha'),
      'docs/ref.md': entry('REF', '- 정책: `BR-1`\n- 연결: `docs/x.md`, `MISS`\n'),
    });
    const two = makeRepo(space.path('two'), { 'docs/x.md': body('bravo') });
    const store = space.track(openForWrite(space.path('k.sqlite')));
    index(store, configOf([sourceConfig(one, { id: 's1', project: 'p' }), sourceConfig(two, { id: 's2', project: 'p' })]));

    const links = JSON.parse(statusOf(store.db, 's1:docs/ref.md#REF').links_json) as unknown[];
    assert.deepEqual(links, [
      { relation: 'policy', target: 'BR-1', resolved: false, kind: 'item', ambiguous: true, candidates: ['s1:docs/b.md#BR-1', 's1:docs/z.md#BR-1'] },
      { relation: 'related', target: 'MISS', resolved: false, kind: 'item' },
      { relation: 'related', target: 'docs/x.md', resolved: false, kind: 'item', ambiguous: true, candidates: ['s1:docs/x.md#제목', 's2:docs/x.md#제목'] },
    ]);
    assert.equal(statusOf(store.db, 's1:docs/b.md#BR-1').effective_status, 'conflicted');
  });

  it('keeps identical content at two paths as two documents', (t) => {
    const { store, db, config } = setup(t, { 'docs/a.md': body('twin'), 'docs/b.md': body('twin') });
    assert.equal(index(store, config).documentCount, 2);
    assert.deepEqual(searchActive(db, 'twin'), [A_ID, 'src:docs/b.md#제목']);
  });
});
