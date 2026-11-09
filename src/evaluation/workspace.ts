import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { KnowledgeError } from '../errors.js';
import { runIndex } from '../indexing/indexer.js';
import { openForWrite } from '../indexing/store.js';
import { loadSourcesConfig, type SourcesConfig } from '../sources/config.js';
import { gitChildEnv } from '../sources/git.js';

const GIT_TIMEOUT_MS = 120_000;
const FIXTURE_GIT = ['-c', 'core.autocrlf=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];

// 원본 항목의 세부 검증은 실제 설정 로더가 맡는다. 여기서는 디렉터리 이름인 id만 확인한다
const workspaceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sources: z.array(z.looseObject({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/) })).min(1),
});

export interface MaterializedWorkspace {
  dbPath: string;
  config: SourcesConfig;
  dispose(): void;
}

function git(repo: string, args: string[]): void {
  execFileSync('git', ['-C', repo, ...FIXTURE_GIT, ...args], { shell: false, windowsHide: true, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], env: gitChildEnv() });
}

function readWorkspace(workspace: string): z.infer<typeof workspaceSchema> {
  const raw: unknown = parse(readFileSync(join(workspace, 'workspace.yaml'), 'utf8').replace(/^﻿/, ''));
  return workspaceSchema.parse(raw);
}

function materializeSource(workspace: string, repos: string, id: string): string {
  const from = join(workspace, id);
  if (!statSync(from, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`fixture 디렉터리가 없습니다: ${from}`);
  const repo = join(repos, id);
  cpSync(from, repo, { recursive: true });
  git(repo, ['-c', 'init.defaultBranch=main', 'init']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--no-verify', '-m', 'fixture']);
  return repo;
}

/** 원본 저장소에 쓰지 않도록 fixture를 임시 Git 저장소로 복사하고 임시 DB에 색인한다. */
export function materializeWorkspace(workspace: string, onProgress: (message: string) => void): MaterializedWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'agent-knowledge-eval-'));
  const dispose = (): void => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      // 임시 파일 정리 실패가 평가 결과를 뒤집으면 안 된다
      onProgress(`임시 디렉터리를 지우지 못했습니다: ${root} (${(error as Error).message})`);
    }
  };
  try {
    const { sources } = readWorkspace(workspace);
    const repos = join(root, 'repos');
    mkdirSync(repos);
    const dbPath = join(root, 'knowledge.sqlite');
    const configPath = join(root, 'sources.yaml');
    const entries = sources.map((source) => ({ ...source, path: materializeSource(workspace, repos, source.id) }));
    // JSON은 YAML의 부분집합이므로 임시 설정을 따로 직렬화할 필요가 없다
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, database: { path: dbPath }, sources: entries }));
    const config = loadSourcesConfig(configPath);

    const store = openForWrite(dbPath);
    try {
      const result = runIndex({ config, store, onProgress: (event) => onProgress(event.message) });
      onProgress(`평가용 색인을 만들었습니다: 세대 ${result.generation}, 문서 ${result.documentCount}개, 항목 ${result.itemCount}개`);
    } finally {
      store.close();
    }
    return { dbPath, config, dispose };
  } catch (error) {
    dispose();
    throw new KnowledgeError('eval-failed', `평가용 작업 공간을 준비하지 못했습니다: ${workspace}`, { reason: 'workspace-failed', workspace, cause: error instanceof Error ? error.message : String(error) });
  }
}
