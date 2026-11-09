import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadRetrievalConfig, openForWrite, runIndex, type IndexResult, type RetrievalContext, type RunIndexOptions, type SourceConfig, type SourcesConfig } from '../src/index.js';

const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false'];

export function git(repo: string, args: string[], input?: string | Buffer): string {
  return execFileSync('git', ['-C', repo, ...IDENTITY, ...args], { input, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

interface Closable {
  close(): void;
}

export class TempSpace {
  readonly root = mkdtempSync(join(tmpdir(), 'agent-knowledge-test-'));
  private readonly closables: Closable[] = [];

  /** Windows에서는 열린 DB 파일을 지울 수 없으므로 정리 전에 닫을 대상을 등록한다. */
  track<T extends Closable>(resource: T): T {
    this.closables.push(resource);
    return resource;
  }

  path(...segments: string[]): string {
    return join(this.root, ...segments);
  }

  dispose(): void {
    for (const resource of this.closables.splice(0)) {
      try {
        resource.close();
      } catch {
        // 이미 닫힌 DB는 정리를 막지 않는다
      }
    }
    rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export function tempSpace(t: TestContext): TempSpace {
  const space = new TempSpace();
  t.after(() => space.dispose());
  return space;
}

export type RepoFiles = Record<string, string | Buffer | null>;

export function writeFiles(repo: string, files: RepoFiles): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(repo, path);
    if (content === null) {
      rmSync(target, { force: true, maxRetries: 10 });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
}

/** files의 값이 null이면 파일을 지운다. 만든 커밋의 SHA를 돌려준다. */
export function commit(repo: string, files: RepoFiles, message = 'change'): string {
  writeFiles(repo, files);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--allow-empty', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

export function makeRepo(path: string, files: RepoFiles = {}): string {
  mkdirSync(path, { recursive: true });
  git(path, ['-c', 'init.defaultBranch=main', 'init']);
  // 소스 코드의 git 호출은 저장소 설정을 그대로 읽으므로 사용자 전역 설정의 영향을 막는다
  git(path, ['config', 'core.autocrlf', 'false']);
  if (Object.keys(files).length > 0) commit(path, files, 'initial');
  return path;
}

export function hashObject(repo: string, content: string | Buffer): string {
  return git(repo, ['hash-object', '-w', '--stdin'], content);
}

export const RETRIEVAL_CONFIG_PATH = fileURLToPath(new URL('../../config/retrieval.yaml', import.meta.url));

export interface FixtureSource {
  id: string;
  project?: string;
  files: RepoFiles;
  extra?: Partial<SourceConfig>;
}

export interface KnowledgeFixture {
  space: TempSpace;
  dbPath: string;
  config: SourcesConfig;
  context: RetrievalContext;
  repo(sourceId: string): string;
  /** 현재 커밋을 색인한다. 호출이 끝나면 쓰기 연결을 닫는다. */
  index(options?: Partial<RunIndexOptions>): IndexResult;
}

export function knowledgeFixture(t: TestContext, sources: FixtureSource[], retainGenerations = 5): KnowledgeFixture {
  const space = tempSpace(t);
  const repos = new Map(sources.map((source) => [source.id, makeRepo(space.path('repos', source.id), source.files)]));
  const dbPath = space.path('db', 'k.sqlite');
  const config: SourcesConfig = {
    schemaVersion: 1,
    configPath: space.path('sources.yaml'),
    database: { path: dbPath },
    index: { retainGenerations, maxFileBytes: 65536 },
    sources: sources.map((source) => ({ id: source.id, project: source.project ?? source.id, path: repos.get(source.id)!, ref: 'HEAD', include: ['**/*.md'], exclude: [], defaultKind: 'reference', rules: [], maxFileBytes: 65536, ...source.extra })),
  };
  return {
    space,
    dbPath,
    config,
    context: { dbPath, sources: config, retrieval: loadRetrievalConfig(RETRIEVAL_CONFIG_PATH) },
    repo: (sourceId) => repos.get(sourceId)!,
    index(options = {}) {
      const store = openForWrite(dbPath);
      try {
        return runIndex({ config, store, onProgress: () => {}, ...options });
      } finally {
        store.close();
      }
    },
  };
}

/** 파일 시스템이 거부하는 이름(비 UTF-8 등)도 커밋할 수 있도록 fast-import로 현재 브랜치의 첫 커밋을 만든다. */
export function commitRawNames(repo: string, files: { name: string | Buffer; content: string; mode?: string }[]): string {
  const chunks = [Buffer.from('commit refs/heads/main\ncommitter test <test@example.invalid> 0 +0000\ndata 1\nx\n')];
  for (const { name, content, mode = '100644' } of files) {
    chunks.push(Buffer.from(`M ${mode} inline `), Buffer.from(name), Buffer.from(`\ndata ${Buffer.byteLength(content)}\n${content}\n`));
  }
  git(repo, ['fast-import', '--quiet'], Buffer.concat(chunks));
  return git(repo, ['rev-parse', 'refs/heads/main']);
}

/** 권한 없이도 심볼릭 링크와 서브모듈을 만들 수 있도록 인덱스에 직접 넣는다. */
export function addIndexEntry(repo: string, mode: string, sha: string, path: string): void {
  git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`]);
}
