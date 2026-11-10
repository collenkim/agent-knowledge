import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { refHandle } from '../src/retrieval/compose-v2.js';
import { gitChildEnv } from '../src/sources/git.js';

/**
 * docs/contract/의 정본 예제를 임시 Git 저장소와 임시 DB에서 실제 CLI로 다시 실행한다.
 * 예제의 stdout은 실제 응답의 부분 집합이어야 한다. 객체 키는 생략할 수 있지만 배열은 길이까지 같아야 하고 빈 객체 {}는 빈 객체와만 맞는다.
 */

export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CONTRACT_DIR = join(PACKAGE_ROOT, 'docs', 'contract');
const CLI = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));
const RETRIEVAL_CONFIG = join(PACKAGE_ROOT, 'config', 'retrieval.yaml');

// src/evaluation/workspace.ts와 같은 작성자·시각을 써서 같은 fixture가 같은 커밋 SHA가 되게 한다
const FIXTURE_DATE = '2026-01-01T00:00:00Z';
const FIXTURE_NAME = 'fixture';
const FIXTURE_EMAIL = 'fixture@example.invalid';
// Git for Windows도 /dev/null을 빈 파일로 읽는다. os.devNull은 Windows에서 설정 경로로 받지 않는다
const GIT_NULL = '/dev/null';
// 사용자·시스템 Git 설정과 상속된 작성자 변수가 커밋·블롭 SHA를 바꾸지 못하게 한다. 환경 변수는 모든 설정 단계보다 앞선다
const FIXTURE_ENV = {
  GIT_AUTHOR_NAME: FIXTURE_NAME,
  GIT_AUTHOR_EMAIL: FIXTURE_EMAIL,
  GIT_AUTHOR_DATE: FIXTURE_DATE,
  GIT_COMMITTER_NAME: FIXTURE_NAME,
  GIT_COMMITTER_EMAIL: FIXTURE_EMAIL,
  GIT_COMMITTER_DATE: FIXTURE_DATE,
  GIT_CONFIG_GLOBAL: GIT_NULL,
  GIT_CONFIG_NOSYSTEM: '1',
};
// 전역 설정을 비워도 XDG 기본 속성·무시 파일은 읽히므로 따로 끈다
const FIXTURE_GIT = ['-c', 'core.autocrlf=false', '-c', `core.attributesFile=${GIT_NULL}`, '-c', `core.excludesFile=${GIT_NULL}`, '-c', 'commit.gpgsign=false'];
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PRIMARY = 'primary';
const EXPIRED_AT = '2000-01-01T00:00:00.000Z';

const HANDLE = /^ak-[0-9a-f]{20}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const fixtureSchema = z.strictObject({
  workspace: z.string().min(1),
  retainGenerations: z.number().int().min(1).optional(),
  databases: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1).optional(),
});

const cliStepSchema = z.strictObject({
  id: z.string().min(1),
  note: z.string().optional(),
  db: z.string().optional(),
  argv: z.array(z.string()).min(1),
  request: z.unknown().optional(),
  exitCode: z.number().int(),
  stdout: z.unknown(),
});

const commitStepSchema = z.strictObject({
  id: z.string().min(1),
  note: z.string().optional(),
  // 값이 문자열이면 파일 전체, null이면 삭제, replace면 파일 안에서 한 번만 나오는 문자열을 바꾼다
  commit: z.strictObject({
    source: z.string().min(1),
    files: z.record(z.string().refine(safeRelative, 'repository-relative path'), z.union([z.string(), z.null(), z.strictObject({ replace: z.tuple([z.string().min(1), z.string()]) })])),
  }),
});

const expireStepSchema = z.strictObject({
  id: z.string().min(1),
  note: z.string().optional(),
  expireLeases: z.strictObject({ db: z.string().optional() }),
});

export const scenarioSchema = z.strictObject({
  schema: z.literal('agent-knowledge.contract-example'),
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  fixture: fixtureSchema,
  notes: z.array(z.string()).optional(),
  steps: z.array(z.union([cliStepSchema, commitStepSchema, expireStepSchema])).min(1),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioStep = Scenario['steps'][number];
export type CliStep = z.infer<typeof cliStepSchema>;
export type Fixture = z.infer<typeof fixtureSchema>;

export function isCliStep(step: ScenarioStep): step is CliStep {
  return 'argv' in step;
}

export function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function loadScenario(path: string): Scenario {
  return scenarioSchema.parse(loadJson(path));
}

export function scenarioFiles(): string[] {
  return readdirSync(CONTRACT_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(CONTRACT_DIR, name))
    .filter((path) => (loadJson(path) as { schema?: unknown }).schema === 'agent-knowledge.contract-example')
    .sort();
}

function git(repo: string, args: string[], hooks: string): string {
  const env = { ...gitChildEnv(), ...FIXTURE_ENV };
  return execFileSync('git', ['-C', repo, ...FIXTURE_GIT, '-c', `core.hooksPath=${hooks}`, ...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env, encoding: 'utf8' }).trim();
}

/** 체크아웃의 줄바꿈 설정과 상관없이 같은 바이트가 되도록 fixture를 LF로 바꿔 복사한다. */
function copyNormalized(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true });
      copyNormalized(source, target);
    } else {
      writeFileSync(target, readFileSync(source, 'utf8').replace(/\r\n/g, '\n'));
    }
  }
}

interface WorkspaceSource {
  id: string;
  [key: string]: unknown;
}

/** 예제가 쓰는 경로는 저장소 기준 상대 경로여야 한다. 임시 디렉터리 밖을 고치지 못하게 한다. */
function safeRelative(path: string): boolean {
  if (path === '' || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function inside(root: string, path: string): string {
  const target = resolve(root, path);
  assert.ok(target.startsWith(resolve(root) + sep), `path escapes the fixture repository: ${path}`);
  return target;
}

export interface CliResult {
  exitCode: number;
  stdout: unknown;
}

/** 예제 하나를 실행하는 임시 환경. 모든 파일은 OS 임시 디렉터리 안에만 만든다. */
export class ContractRun {
  readonly root = mkdtempSync(join(tmpdir(), 'agent-knowledge-contract-'));
  private readonly hooks = join(this.root, 'no-hooks');
  private readonly repos = new Map<string, string>();
  private readonly dbs = new Map<string, string>();
  private readonly indexIds = new Map<string, string>();
  private readonly configPath = join(this.root, 'sources.yaml');
  private lastLeaseId: string | undefined;
  private readonly leaseIds = new Map<string, string>();

  constructor(fixture: Fixture) {
    try {
      mkdirSync(this.hooks);
      const workspace = join(PACKAGE_ROOT, fixture.workspace);
      const { sources } = parse(readFileSync(join(workspace, 'workspace.yaml'), 'utf8')) as { sources: WorkspaceSource[] };
      const entries = sources.map((source) => {
        assert.ok(SOURCE_ID.test(source.id), `invalid source id: ${source.id}`);
        const repo = join(this.root, 'repos', source.id);
        mkdirSync(repo, { recursive: true });
        copyNormalized(join(workspace, source.id), repo);
        git(repo, ['-c', 'init.defaultBranch=main', 'init', '--object-format=sha1'], this.hooks);
        // 어떤 속성 파일도 줄바꿈을 바꾸지 못하게 한다. 예제의 CRLF·CR 파일은 그 바이트 그대로 커밋해야 한다
        mkdirSync(join(repo, '.git', 'info'), { recursive: true });
        writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -text\n');
        git(repo, ['add', '-A'], this.hooks);
        git(repo, ['commit', '--no-verify', '-m', 'fixture'], this.hooks);
        this.repos.set(source.id, repo);
        return { ...source, path: repo };
      });
      for (const name of fixture.databases ?? [PRIMARY]) this.dbs.set(name, join(this.root, 'db', `${name}.sqlite`));
      mkdirSync(join(this.root, 'db'));
      writeFileSync(this.configPath, JSON.stringify({ schemaVersion: 1, database: { path: this.dbs.get(PRIMARY) ?? [...this.dbs.values()][0] }, index: { retainGenerations: fixture.retainGenerations ?? 5 }, sources: entries }));
      for (const name of this.dbs.keys()) {
        const indexed = this.cli(['index'], undefined, name);
        assert.equal(indexed.exitCode, 0, `fixture index failed: ${JSON.stringify(indexed.stdout)}`);
        this.indexIds.set(name, this.readIndexId(name));
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  indexId(db = PRIMARY): string {
    const found = this.indexIds.get(db);
    assert.ok(found, `unknown database: ${db}`);
    return found;
  }

  private repo(sourceId: string): string {
    const found = this.repos.get(sourceId);
    assert.ok(found, `unknown source: ${sourceId}`);
    return found;
  }

  private db(name = PRIMARY): string {
    const found = this.dbs.get(name);
    assert.ok(found, `unknown database: ${name}`);
    return found;
  }

  private readIndexId(name: string): string {
    const db = new DatabaseSync(this.db(name), { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'index_id'").get() as { value: string } | undefined;
      assert.ok(row, 'index_id missing');
      return row.value;
    } finally {
      db.close();
    }
  }

  private cli(argv: readonly string[], input: string | undefined, db: string): CliResult {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('AGENT_KNOWLEDGE_')));
    const args = [...argv, '--config', this.configPath, '--db', this.db(db), '--retrieval-config', RETRIEVAL_CONFIG, '--quiet'];
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, input, env });
    assert.equal(result.error, undefined);
    assert.equal(result.stdout.trimEnd().includes('\n'), false, `expected one JSON line: ${result.stdout}`);
    return { exitCode: result.status!, stdout: JSON.parse(result.stdout) as unknown };
  }

  /** 예제의 자리표시를 이번 실행의 값으로 바꾼다. `<handle>`은 같은 객체의 식별 필드로 다시 계산한다. */
  substitute(value: unknown): unknown {
    if (typeof value === 'string') return this.substituteString(value);
    if (Array.isArray(value)) return value.map((item) => this.substitute(item));
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, item]) => [key, this.substitute(item)] as const);
      const object = Object.fromEntries(entries) as Record<string, unknown>;
      if (object.handle === '<handle>') {
        object.handle = refHandle({
          indexId: object.indexId as string,
          indexGeneration: object.indexGeneration as number,
          itemId: object.itemId as string,
          segmentId: (object.segmentId as string | null | undefined) ?? null,
          itemSha256: object.itemSha256 as string,
          segmentSha256: (object.segmentSha256 as string | null | undefined) ?? null,
        });
      }
      return object;
    }
    return value;
  }

  private substituteString(value: string): string {
    if (value === '<lease-id>') {
      assert.ok(this.lastLeaseId, 'no lease acquired yet');
      return this.lastLeaseId;
    }
    const leaseOf = /^<lease-id:(.+)>$/.exec(value);
    if (leaseOf) {
      const found = this.leaseIds.get(leaseOf[1]!);
      assert.ok(found, `no lease from step ${leaseOf[1]}`);
      return found;
    }
    const indexId = /^<index-id(?::([a-z][a-z0-9-]*))?>$/.exec(value);
    if (indexId) return this.indexId(indexId[1] ?? PRIMARY);
    return value;
  }

  /** 실행마다 달라지는 값을 자리표시로 바꾼다. 나머지 값은 같은 fixture에서 언제나 같다. */
  normalize(value: unknown, key?: string, parent?: string): unknown {
    if (typeof value === 'string') {
      if (key === 'leaseId') return '<lease-id>';
      if (parent === 'digests') return '<digest>';
      for (const [name, id] of this.indexIds) if (value === id) return name === PRIMARY ? '<index-id>' : `<index-id:${name}>`;
      if (HANDLE.test(value)) return '<handle>';
      if (TIMESTAMP.test(value)) return '<time>';
      let text = value.split(this.root).join('<tmp>');
      // 오류 문구에 들어간 임대 ID도 실행마다 다르다
      for (const leaseId of this.leaseIds.values()) text = text.split(leaseId).join('<lease-id>');
      return text;
    }
    if (Array.isArray(value)) return value.map((item) => this.normalize(item, undefined, parent));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.normalize(item, name, key)]));
    }
    return value;
  }

  /** 응답에 임대가 있으면 마지막 임대와 단계 ID별 임대로 기억한다. `<lease-id:단계 ID>`로 다시 쓴다. */
  private rememberLease(stepId: string, stdout: unknown): void {
    const doc = stdout as { lease?: { leaseId?: unknown } | null };
    if (typeof doc?.lease?.leaseId !== 'string') return;
    this.lastLeaseId = doc.lease.leaseId;
    if (!this.leaseIds.has(stepId)) this.leaseIds.set(stepId, doc.lease.leaseId);
  }

  /** CLI 단계는 정규화한 응답을, 그 밖의 단계는 undefined를 돌려준다. */
  run(step: ScenarioStep): CliResult | undefined {
    if ('commit' in step) {
      const repo = this.repo(step.commit.source);
      for (const [path, content] of Object.entries(step.commit.files)) {
        const target = inside(repo, path);
        if (content === null) rmSync(target, { force: true });
        else if (typeof content === 'string') {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
        } else {
          const [from, to] = content.replace;
          const text = readFileSync(target, 'utf8');
          assert.equal(text.split(from).length, 2, `${path}: replace target must occur once`);
          writeFileSync(target, text.replace(from, () => to));
        }
      }
      git(repo, ['add', '-A'], this.hooks);
      git(repo, ['commit', '--no-verify', '-m', step.id], this.hooks);
      return undefined;
    }
    if ('expireLeases' in step) {
      // 임대 기간이 지난 상태를 기다리지 않고 만든다. 생산자 코드가 아니라 이 예제 실행기만 DB를 고친다
      const db = new DatabaseSync(this.db(step.expireLeases.db));
      try {
        db.prepare('UPDATE generation_leases SET expires_at = ?').run(EXPIRED_AT);
      } finally {
        db.close();
      }
      return undefined;
    }
    const argv = step.argv.map((arg) => this.substituteString(arg));
    const input = step.request === undefined ? undefined : JSON.stringify(this.substitute(step.request));
    const result = this.cli(argv, input, step.db ?? PRIMARY);
    this.rememberLease(step.id, result.stdout);
    return { exitCode: result.exitCode, stdout: this.normalize(result.stdout) };
  }
}

/** expected가 actual의 부분 집합인지 본다. 처음 어긋난 경로를 돌려준다. */
export function subsetMismatch(expected: unknown, actual: unknown, path = '$'): string | undefined {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected array, got ${JSON.stringify(actual)}`;
    if (expected.length !== actual.length) return `${path}: expected ${expected.length} elements, got ${actual.length}`;
    for (let index = 0; index < expected.length; index++) {
      const found = subsetMismatch(expected[index], actual[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return `${path}: expected object, got ${JSON.stringify(actual)}`;
    // 빈 객체는 생략이 아니라 값이다. 실제 값도 비어 있어야 한다
    if (Object.keys(expected).length === 0 && Object.keys(actual).length > 0) return `${path}: expected {}, got ${JSON.stringify(actual)}`;
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key)) return `${path}.${key}: missing`;
      const found = subsetMismatch(value, (actual as Record<string, unknown>)[key], `${path}.${key}`);
      if (found) return found;
    }
    return undefined;
  }
  return Object.is(expected, actual) ? undefined : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

export function relativeToPackage(path: string): string {
  return relative(PACKAGE_ROOT, path).replace(/\\/g, '/');
}
