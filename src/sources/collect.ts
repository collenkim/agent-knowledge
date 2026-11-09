import { compareStrings } from '../util/compare.js';
import { globToRegExp } from '../util/glob.js';
import type { SourceConfig } from './config.js';
import { assertGitToplevel, lsTree, resolveCommit } from './git.js';
import { isBlockedPath, isMarkdownPath } from './path-policy.js';

type SkipReason = 'blocked-path' | 'too-large' | 'not-utf8' | 'not-utf8-path' | 'binary';

export interface Candidate {
  path: string;
  sha: string;
  size: number;
}

export interface SkippedPath {
  path: string;
  reason: SkipReason;
}

export interface CollectedSource {
  commit: string;
  requestedRef: string;
  tracked: Set<string>;
  candidates: Candidate[];
  skipped: SkippedPath[];
}

const REGULAR_FILE_MODES = new Set(['100644', '100755']);

export function collectSource(cfg: SourceConfig, refOverride?: string): CollectedSource {
  assertGitToplevel(cfg.path);
  const requestedRef = refOverride ?? cfg.ref;
  const commit = resolveCommit(cfg.path, requestedRef);
  const include = cfg.include.map(globToRegExp);
  const exclude = cfg.exclude.map(globToRegExp);
  const tracked = new Set<string>();
  const candidates: Candidate[] = [];
  const skipped: SkippedPath[] = [];

  for (const entry of lsTree(cfg.path, commit)) {
    // 심볼릭 링크와 서브모듈은 저장소 밖을 가리킬 수 있어 내용을 읽지 않고 근거나 코드 연결로도 해석하지 않는다
    if (!REGULAR_FILE_MODES.has(entry.mode)) continue;
    if (!entry.invalidUtf8) tracked.add(entry.path);
    if (!include.some((glob) => glob.test(entry.path)) || exclude.some((glob) => glob.test(entry.path))) continue;
    if (isBlockedPath(entry.path)) skipped.push({ path: entry.path, reason: 'blocked-path' });
    else if (!isMarkdownPath(entry.path)) continue;
    else if (entry.invalidUtf8) skipped.push({ path: entry.path, reason: 'not-utf8-path' });
    else if (entry.size! > cfg.maxFileBytes) skipped.push({ path: entry.path, reason: 'too-large' });
    else candidates.push({ path: entry.path, sha: entry.sha, size: entry.size! });
  }

  candidates.sort((a, b) => compareStrings(a.path, b.path));
  skipped.sort((a, b) => compareStrings(a.path, b.path));
  return { commit, requestedRef, tracked, candidates, skipped };
}

type DecodedBlob = { text: string } | { reason: 'not-utf8' | 'binary' };

export function decodeBlob(bytes: Uint8Array): DecodedBlob {
  if (bytes.includes(0)) return { reason: 'binary' };
  try {
    // TextDecoder는 기본값으로 선두 BOM을 제거한다
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { reason: 'not-utf8' };
  }
}
