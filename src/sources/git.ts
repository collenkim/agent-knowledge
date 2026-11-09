import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { KnowledgeError } from '../errors.js';

const TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;
const MAX_PATHSPEC_CHARS = 24_000;
const TREE_META = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64}) +(\d+|-)$/;
const BLOB_HEADER = /^([0-9a-f]{40,64}) (\w+) (\d+)$/;
// 파일 이름 맨 앞의 BOM도 경로의 일부이므로 지우지 않는다
const PATH_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// `git rev-parse --local-env-vars`의 목록. 상속되면 -C로 지정한 저장소 대신 다른 저장소를 읽는다
const LOCAL_ENV_VARS = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);

interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size: number | null;
  /** invalidUtf8이면 실제 경로가 아니라 표시용으로 이스케이프한 이름이다. */
  path: string;
  invalidUtf8?: true;
}

interface BlobRef {
  sha: string;
  size: number;
}

function unavailable(root: string, message: string, detail?: object): KnowledgeError {
  return new KnowledgeError('source-unavailable', `원본 저장소를 읽을 수 없습니다: ${message}`, { root, ...detail });
}

export function gitChildEnv(): NodeJS.ProcessEnv {
  // Windows의 환경 변수 이름은 대소문자를 구분하지 않으므로 git_dir도 GIT_DIR로 읽힌다
  const canonical = (name: string): string => (process.platform === 'win32' ? name.toUpperCase() : name);
  const inherited = Object.entries(process.env).filter(([name]) => !LOCAL_ENV_VARS.has(canonical(name)));
  return { ...Object.fromEntries(inherited), GIT_OPTIONAL_LOCKS: '0' };
}

function git(root: string, args: string[], options: { input?: string; maxBuffer?: number } = {}): Buffer {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      shell: false,
      windowsHide: true,
      timeout: TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      input: options.input,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: gitChildEnv(),
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number | null; stderr?: Buffer };
    throw unavailable(root, `git ${args[0]} 실패`, {
      command: args[0],
      status: failure.status ?? null,
      errno: failure.code ?? null,
      stderr: failure.stderr?.toString('utf8').trim().slice(0, 2000) ?? '',
    });
  }
}

export function resolveCommit(root: string, ref: string): string {
  // `-`로 시작하는 ref는 git이 옵션으로 해석한다
  if (ref.startsWith('-')) throw unavailable(root, `허용되지 않는 ref입니다: ${ref}`, { ref });
  return git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).toString('utf8').trim();
}

function samePath(a: string, b: string): boolean {
  const left = realpathSync.native(a);
  const right = realpathSync.native(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** 하위 디렉터리를 원본으로 두면 ls-tree --full-tree가 바깥 저장소 전체를 그 프로젝트의 문서로 읽는다. */
export function assertGitToplevel(root: string): void {
  // bare 저장소와 .git 내부에서는 --show-toplevel이 실패하므로 작업 트리인지 먼저 본다
  const inWorkTree = git(root, ['rev-parse', '--is-inside-work-tree']).toString('utf8').trim() === 'true';
  if (!inWorkTree || !samePath(git(root, ['rev-parse', '--show-toplevel']).toString('utf8').trim(), root)) {
    throw unavailable(root, `Git 최상위 경로가 아닙니다: ${root}`, { reason: 'not-git-toplevel' });
  }
}

function decodePath(bytes: Uint8Array): string | null {
  try {
    return PATH_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

/** 깨진 바이트만 \xHH로 바꾼다. U+FFFD로 뭉개면 서로 다른 이름을 구분할 수 없다. */
function escapeInvalidUtf8(bytes: Buffer): string {
  let shown = '';
  for (let start = 0; start < bytes.length; ) {
    const length = [1, 2, 3, 4].find((size) => start + size <= bytes.length && isUtf8(bytes.subarray(start, start + size)));
    shown += length === undefined ? `\\x${bytes[start]!.toString(16).padStart(2, '0')}` : bytes.toString('utf8', start, start + length);
    start += length ?? 1;
  }
  return shown;
}

export function lsTree(root: string, commit: string): TreeEntry[] {
  const output = git(root, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit]);
  const entries: TreeEntry[] = [];
  let position = 0;
  while (position < output.length) {
    const end = output.indexOf(0, position);
    const tab = output.indexOf(0x09, position);
    const meta = end < 0 || tab < 0 || tab > end ? null : TREE_META.exec(output.toString('latin1', position, tab));
    if (!meta) throw unavailable(root, 'ls-tree 출력을 해석할 수 없습니다');
    const name = output.subarray(tab + 1, end);
    const path = decodePath(name);
    entries.push({
      mode: meta[1]!,
      type: meta[2] as TreeEntry['type'],
      sha: meta[3]!,
      size: meta[4] === '-' ? null : Number(meta[4]),
      path: path ?? escapeInvalidUtf8(name),
      ...(path === null ? { invalidUtf8: true as const } : {}),
    });
    position = end + 1;
  }
  return entries;
}

/** 본문에 개행과 NUL이 있을 수 있어 헤더의 크기만큼 바이트로 잘라 읽는다. */
export function readBlobs(root: string, blobs: readonly BlobRef[]): Map<string, Buffer> {
  const unique = new Map(blobs.map((blob) => [blob.sha, blob.size]));
  const contents = new Map<string, Buffer>();
  if (unique.size === 0) return contents;

  let maxBuffer = 0;
  for (const [sha, size] of unique) maxBuffer += sha.length + ' blob '.length + String(size).length + 1 + size + 1;
  const output = git(root, ['cat-file', '--batch'], { input: [...unique.keys()].map((sha) => `${sha}\n`).join(''), maxBuffer });

  let position = 0;
  for (const sha of unique.keys()) {
    const newline = output.indexOf(0x0a, position);
    if (newline < 0) throw unavailable(root, 'cat-file 출력이 잘렸습니다', { sha });
    const header = output.toString('latin1', position, newline);
    if (header.endsWith(' missing')) throw unavailable(root, `객체가 없습니다: ${sha}`, { sha });
    const match = BLOB_HEADER.exec(header);
    if (match?.[1] !== sha || match[2] !== 'blob') throw unavailable(root, 'cat-file 헤더를 해석할 수 없습니다', { sha, header });
    const start = newline + 1;
    const end = start + Number(match[3]);
    if (output[end] !== 0x0a) throw unavailable(root, 'cat-file 본문이 잘렸습니다', { sha });
    contents.set(sha, output.subarray(start, end));
    position = end + 1;
  }
  return contents;
}

export function commitExists(root: string, sha: string): boolean {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return false;
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    return true;
  } catch (error) {
    // --quiet에서 종료 코드 1은 "없음"이고, 그 밖의 실패는 저장소 자체의 장애다
    if (error instanceof KnowledgeError && (error.detail as { status?: number }).status === 1) return false;
    throw error;
  }
}

export function isDirty(root: string, paths: readonly string[]): boolean {
  // 문서가 많으면 Windows 명령줄 길이 제한을 넘으므로 나눠서 묻는다
  let batch: string[] = [];
  let chars = 0;
  const dirty = (): boolean => git(root, ['--literal-pathspecs', 'status', '--porcelain', '-z', '--', ...batch]).length > 0;
  for (const path of paths) {
    if (chars + path.length > MAX_PATHSPEC_CHARS && batch.length > 0) {
      if (dirty()) return true;
      batch = [];
      chars = 0;
    }
    batch.push(path);
    chars += path.length + 3;
  }
  return batch.length > 0 && dirty();
}
