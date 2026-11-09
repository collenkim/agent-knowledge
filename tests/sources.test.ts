import assert from 'node:assert/strict';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES, KnowledgeError, type ErrorCode } from '../src/errors.js';
import { materializeWorkspace } from '../src/evaluation/workspace.js';
import { resolveBaseStatus } from '../src/indexing/resolve.js';
import { collectSource, decodeBlob } from '../src/sources/collect.js';
import { findRule, loadSourcesConfig, type SourceConfig, type SourcesConfig } from '../src/sources/config.js';
import { commitExists, gitChildEnv, isDirty, lsTree, readBlobs, resolveCommit } from '../src/sources/git.js';
import { isBlockedPath, isMarkdownPath } from '../src/sources/path-policy.js';
import { validateSources } from '../src/sources/validate.js';
import { compareStrings } from '../src/util/compare.js';
import { matchesGlob, pathsOverlap } from '../src/util/glob.js';
import { canonicalJson, sha256 } from '../src/util/hash.js';
import { normalizeRepoPath } from '../src/util/paths.js';
import { addIndexEntry, commit, commitRawNames, git, hashObject, makeRepo, tempSpace, writeFiles, type TempSpace } from './helpers.js';

function assertKnowledgeError(fn: () => unknown, code: ErrorCode): KnowledgeError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof KnowledgeError, String(error));
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

function sourceConfig(path: string, extra: Partial<SourceConfig> = {}): SourceConfig {
  return { id: 'src', project: 'proj', path, ref: 'HEAD', include: ['**/*.md'], exclude: [], defaultKind: 'reference', rules: [], maxFileBytes: 1024, ...extra };
}

describe('errors and utilities', () => {
  it('maps every error code to the designed exit code', () => {
    assert.deepEqual(EXIT_CODES, {
      usage: 2,
      'invalid-request': 2,
      'config-invalid': 7,
      'source-unavailable': 8,
      'index-failed': 8,
      'index-conflict': 8,
      'invalid-scope': 4,
      'index-missing': 5,
      'store-unavailable': 6,
      'not-found': 3,
      'eval-failed': 9,
      'internal-error': 1,
    });
  });

  it('orders by UTF-16 code unit', () => {
    assert.deepEqual(['b', 'a', 'B', '가', 'Z'].sort(compareStrings), ['B', 'Z', 'a', 'b', '가']);
  });

  it('hashes UTF-8 and serializes canonical JSON with sorted keys', () => {
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(canonicalJson({ b: [{ d: 1, c: 2 }], a: undefined, A: null }), '{"A":null,"b":[{"c":2,"d":1}]}');
  });

  it('normalizes repository paths and rejects outside ones', () => {
    assert.equal(normalizeRepoPath('.\\src\\a.ts'), 'src/a.ts');
    assert.equal(normalizeRepoPath('././src/a.ts'), 'src/a.ts');
    assert.equal(normalizeRepoPath('src/dir/'), 'src/dir/');
    assert.equal(normalizeRepoPath('.config/a'), '.config/a');
    assert.equal(normalizeRepoPath('a..b/c'), 'a..b/c');
    for (const bad of ['/etc/passwd', '\\\\host\\share', 'C:\\x', 'c:/x', '../x', 'a/../b', 'a\\..\\b', '', './']) {
      assert.equal(normalizeRepoPath(bad), null, bad);
    }
  });

  it('matches globs by segment and case', () => {
    assert.ok(matchesGlob('docs/**/*.md', 'docs/a.md'));
    assert.ok(matchesGlob('docs/**/*.md', 'docs/x/y/a.md'));
    assert.ok(matchesGlob('**/*.md', 'a.md'));
    assert.ok(matchesGlob('docs/**', 'docs/x/y'));
    assert.ok(matchesGlob('a?.md', 'ab.md'));
    assert.ok(matchesGlob('docs/my (file)+[1].md', 'docs/my (file)+[1].md'));
    assert.ok(matchesGlob('문서/*.md', '문서/가.md'));
    assert.ok(!matchesGlob('docs/*.md', 'docs/x/a.md'));
    assert.ok(!matchesGlob('a?.md', 'a/.md'));
    assert.ok(!matchesGlob('DOCS/*.md', 'docs/a.md'));
    assert.ok(!matchesGlob('a.md', 'axmd'));
  });

  it('computes path overlap by exact, glob and segment prefix', () => {
    assert.ok(pathsOverlap('src/a.ts', 'src/a.ts'));
    assert.ok(pathsOverlap('src/a.ts', 'src/*.ts'));
    assert.ok(pathsOverlap('src/x/a.ts', 'src/'));
    assert.ok(pathsOverlap('src/x/a.ts', 'src'));
    assert.ok(!pathsOverlap('srcs/a.ts', 'src'));
    assert.ok(!pathsOverlap('srcs/a.ts', 'src/'));
    assert.ok(!pathsOverlap('src/x/a.ts', 'src/*'));
  });

  it('blocks sensitive segments and extensions and keeps Markdown only', () => {
    for (const path of ['.git/x.md', 'a/.ENV/x.md', '.env.local', 'a/credentials.md', 'secret/x.md', 'a/secrets.prod.md', 'node_modules/x/README.md', 'a/auth.json', 'keys/a.pem', 'x.ZIP', '.claude/a.md']) {
      assert.ok(isBlockedPath(path), path);
    }
    for (const path of ['docs/a.md', 'docs/secretary.md', 'environment/a.md', 'a.key.md']) assert.ok(!isBlockedPath(path), path);
    assert.ok(isMarkdownPath('a.md') && isMarkdownPath('a.markdown') && isMarkdownPath('A.MD'));
    assert.ok(!isMarkdownPath('a.txt') && !isMarkdownPath('md'));
  });
});

describe('sources config', () => {
  const minimal = ['schemaVersion: 1', 'database: {path: ./db/k.sqlite}', 'sources:', '  - id: a', '    project: p', '    path: ../repo', "    include: ['**/*.md']"];

  function write(space: TempSpace, lines: string[], name = 'sources.yaml'): string {
    const path = space.path(name);
    writeFileSync(path, lines.join('\n'));
    return path;
  }

  function issuesOf(space: TempSpace, lines: string[]): { path: string; message: string }[] {
    const error = assertKnowledgeError(() => loadSourcesConfig(write(space, lines)), 'config-invalid');
    return (error.detail as { issues: { path: string; message: string }[] }).issues;
  }

  it('loads the shipped example', () => {
    const example = fileURLToPath(new URL('../../config/sources.example.yaml', import.meta.url));
    const config = loadSourcesConfig(example);
    assert.deepEqual(config.sources.map((source) => source.id), ['order-api', 'shared-knowledge']);
    assert.equal(config.index.retainGenerations, 5);
    assert.deepEqual(config.sources[0]!.rules, [{ match: 'doc/architecture.md', kind: 'architecture' }]);
    assert.equal(config.sources[1]!.defaultKind, 'responsibility');
  });

  it('does not confirm a document through the shipped example rule', () => {
    const example = fileURLToPath(new URL('../../config/sources.example.yaml', import.meta.url));
    const rule = findRule(loadSourcesConfig(example).sources[0]!.rules, 'doc/architecture.md');
    assert.ok(rule);
    const resolution = resolveBaseStatus({ declared: null, rawDeclared: null, basis: [], rule, codeLinks: [] });
    assert.deepEqual([resolution.status, resolution.reason], ['unverified', 'status-not-declared']);
  });

  it('applies defaults and resolves paths against the config file', (t) => {
    const space = tempSpace(t);
    const config = loadSourcesConfig(write(space, minimal));
    assert.equal(config.database.path, space.path('db', 'k.sqlite'));
    assert.deepEqual(config.index, { retainGenerations: 5, maxFileBytes: 1048576 });
    assert.deepEqual(config.sources[0], {
      id: 'a',
      project: 'p',
      path: space.path('..', 'repo'),
      ref: 'HEAD',
      include: ['**/*.md'],
      exclude: [],
      defaultKind: 'reference',
      rules: [],
      maxFileBytes: 1048576,
    });
  });

  it('strips a BOM', (t) => {
    const space = tempSpace(t);
    writeFileSync(space.path('bom.yaml'), `\uFEFF${minimal.join('\n')}`);
    assert.equal(loadSourcesConfig(space.path('bom.yaml')).sources.length, 1);
  });

  it('reports a missing file as not-found', (t) => {
    const error = assertKnowledgeError(() => loadSourcesConfig(tempSpace(t).path('none.yaml')), 'config-invalid');
    assert.equal((error.detail as { reason: string }).reason, 'not-found');
  });

  it('reports broken YAML as issues', (t) => {
    assert.equal(issuesOf(tempSpace(t), ['a: [']).length, 1);
  });

  it('rejects duplicate ids, bad ids, unknown fields and bad retention', (t) => {
    const space = tempSpace(t);
    const dup = [...minimal, '  - id: a', '    project: q', '    path: x', "    include: ['*']"];
    assert.deepEqual(issuesOf(space, dup).map((issue) => issue.path), ['sources.1.id']);
    assert.deepEqual(issuesOf(space, minimal.map((line) => line.replace('id: a', 'id: A!'))).map((i) => i.path), ['sources.0.id']);
    assert.deepEqual(issuesOf(space, [...minimal, 'extra: 1']).map((i) => i.message.includes('extra')), [true]);
    assert.deepEqual(issuesOf(space, [...minimal, 'index: {retainGenerations: 0}']).map((i) => i.path), ['index.retainGenerations']);
    assert.deepEqual(issuesOf(space, [...minimal.slice(0, 3)]).map((i) => i.path), ['sources']);
  });

  it('rejects an empty source list', (t) => {
    assert.deepEqual(issuesOf(tempSpace(t), [...minimal.slice(0, 2), 'sources: []']).map((issue) => issue.path), ['sources']);
  });

  for (const status of ['confirmed_policy', 'verified_experience']) {
    it(`requires a basis for a ${status} rule`, (t) => {
      const space = tempSpace(t);
      const rule = ['    rules:', "      - match: 'a.md'", `        status: ${status}`];
      assert.deepEqual(issuesOf(space, [...minimal, ...rule]).map((i) => i.path), ['sources.0.rules.0.basis']);
      assert.deepEqual(issuesOf(space, [...minimal, ...rule, "        basis: '  '"]).map((i) => i.path), ['sources.0.rules.0.basis']);
      assert.equal(loadSourcesConfig(write(space, [...minimal, ...rule, '        basis: 운영자 확인'])).sources[0]!.rules[0]!.basis, '운영자 확인');
    });
  }

  it('allows other rule statuses without a basis and uses the first matching rule', (t) => {
    const space = tempSpace(t);
    const config = loadSourcesConfig(write(space, [...minimal, '    rules:', "      - {match: 'docs/*.md', status: unverified}", "      - {match: 'docs/a.md', kind: plan}"]));
    assert.equal(findRule(config.sources[0]!.rules, 'docs/a.md')!.status, 'unverified');
    assert.equal(findRule(config.sources[0]!.rules, 'b.md'), null);
  });
});

describe('git adapter', () => {
  it('resolves commits and reports missing refs as source-unavailable', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'a.md': 'a' });
    const head = git(repo, ['rev-parse', 'HEAD']);
    assert.equal(resolveCommit(repo, 'HEAD'), head);
    assert.equal(resolveCommit(repo, head.slice(0, 8)), head);
    assertKnowledgeError(() => resolveCommit(repo, 'no-such-ref'), 'source-unavailable');
    assertKnowledgeError(() => resolveCommit(repo, '--all'), 'source-unavailable');
  });

  it('fails with source-unavailable outside a repository', (t) => {
    const space = tempSpace(t);
    const error = assertKnowledgeError(() => lsTree(space.root, 'HEAD'), 'source-unavailable');
    assert.equal((error.detail as { status: number }).status, 128);
    assertKnowledgeError(() => resolveCommit(space.path('none'), 'HEAD'), 'source-unavailable');
  });

  it('lists names with spaces and Korean without git quoting', (t) => {
    const space = tempSpace(t);
    const repo = makeRepo(space.path('repo'), { 'docs/my notes.md': 'a', '문서/가이드 한글.md': 'bb', 'plain.md': 'ccc' });
    const entries = lsTree(repo, resolveCommit(repo, 'HEAD'));
    assert.deepEqual(entries.map((entry) => [entry.path, entry.size]), [
      ['docs/my notes.md', 1],
      ['plain.md', 3],
      ['문서/가이드 한글.md', 2],
    ]);
    assert.ok(entries.every((entry) => entry.mode === '100644' && entry.type === 'blob' && /^[0-9a-f]{40}$/.test(entry.sha)));
  });

  it('splits at the first TAB so a TAB or quote in a name survives', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'a.md': 'a' });
    // Windows용 git은 기본 설정에서 이런 이름을 거부하므로 이 호출에서만 NTFS 보호를 끈다
    git(repo, ['-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${hashObject(repo, 'x')},we\tird "name".md`]);
    git(repo, ['-c', 'core.protectNTFS=false', 'commit', '-m', 'odd name']);
    assert.ok(lsTree(repo, resolveCommit(repo, 'HEAD')).some((entry) => entry.path === 'we\tird "name".md' && entry.size === 1));
  });

  it('reports symlinks as mode 120000 and gitlinks as commit with null size', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'a.md': 'a' });
    const target = hashObject(repo, '/etc/passwd');
    const gitlink = git(repo, ['rev-parse', 'HEAD']);
    addIndexEntry(repo, '120000', target, 'link.md');
    addIndexEntry(repo, '160000', gitlink, 'vendor/sub');
    git(repo, ['commit', '-m', 'special']);
    const entries = new Map(lsTree(repo, resolveCommit(repo, 'HEAD')).map((entry) => [entry.path, entry]));
    assert.deepEqual(entries.get('link.md'), { mode: '120000', type: 'blob', sha: target, size: 11, path: 'link.md' });
    assert.deepEqual(entries.get('vendor/sub'), { mode: '160000', type: 'commit', sha: gitlink, size: null, path: 'vendor/sub' });
  });

  it('reads blobs byte-exact, with NUL, newlines, empties and duplicates', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'));
    const bodies = [Buffer.from([0x61, 0x00, 0x0a, 0x62, 0x00]), Buffer.from('끝에 개행\n\n'), Buffer.alloc(0), Buffer.from('98 blob 3\nabc\n')];
    const refs = bodies.map((body) => ({ sha: hashObject(repo, body), size: body.length }));
    const result = readBlobs(repo, [...refs, refs[0]!]);
    assert.equal(result.size, 4);
    refs.forEach((ref, index) => assert.ok(result.get(ref.sha)!.equals(bodies[index]!), `body ${index}`));
  });

  it('returns an empty map for no blobs and throws on a missing object', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'a.md': 'a' });
    assert.equal(readBlobs(repo, []).size, 0);
    const error = assertKnowledgeError(() => readBlobs(repo, [{ sha: 'f'.repeat(40), size: 1 }]), 'source-unavailable');
    assert.equal((error.detail as { sha: string }).sha, 'f'.repeat(40));
  });

  it('rejects a non-blob object and undersized reads', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'a.md': 'a long enough body' });
    const head = git(repo, ['rev-parse', 'HEAD']);
    assertKnowledgeError(() => readBlobs(repo, [{ sha: head, size: 10_000 }]), 'source-unavailable');
    const blob = lsTree(repo, head)[0]!;
    const error = assertKnowledgeError(() => readBlobs(repo, [{ sha: blob.sha, size: 1 }]), 'source-unavailable');
    assert.equal((error.detail as { errno: string }).errno, 'ENOBUFS');
  });

  it('checks commit existence without treating a missing commit as an outage', (t) => {
    const space = tempSpace(t);
    const repo = makeRepo(space.path('repo'), { 'a.md': 'a' });
    const head = git(repo, ['rev-parse', 'HEAD']);
    assert.equal(commitExists(repo, head), true);
    assert.equal(commitExists(repo, 'f'.repeat(40)), false);
    assert.equal(commitExists(repo, '--all'), false);
    assert.equal(commitExists(repo, 'HEAD'), false);
    assertKnowledgeError(() => commitExists(space.path('none'), head), 'source-unavailable');
  });

  it('detects dirty paths literally and only for the given paths', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'a.md': 'a', 'b.md': 'b', 'c[1].md': 'c', '문서 하나.md': 'd' });
    assert.equal(isDirty(repo, ['a.md', 'b.md']), false);
    assert.equal(isDirty(repo, []), false);
    writeFiles(repo, { 'b.md': 'changed' });
    assert.equal(isDirty(repo, ['a.md']), false);
    assert.equal(isDirty(repo, ['a.md', 'b.md']), true);
    writeFiles(repo, { 'b.md': 'b', '문서 하나.md': 'changed' });
    assert.equal(isDirty(repo, ['문서 하나.md']), true);
    assert.equal(isDirty(repo, ['c[1].md']), false);
    writeFiles(repo, { 'c[1].md': 'changed' });
    assert.equal(isDirty(repo, ['c[1].md']), true);
  });

  it('handles more dirty-check paths than fit on one command line', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'a.md': 'a' });
    const many = Array.from({ length: 2000 }, (_, i) => `docs/some/long/directory/name/file-number-${i}.md`);
    assert.equal(isDirty(repo, many), false);
    writeFiles(repo, { 'a.md': 'changed' });
    assert.equal(isDirty(repo, [...many, 'a.md']), true);
  });

  it('does not refresh the index of the source repository', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'a.md': 'a' });
    // 내용은 같고 mtime만 다르면 일반 status는 인덱스를 다시 쓰므로 GIT_OPTIONAL_LOCKS가 필요한 상황이다
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(join(repo, 'a.md'), future, future);
    const before = readFileSync(join(repo, '.git', 'index'));
    assert.equal(isDirty(repo, ['a.md']), false);
    assert.ok(readFileSync(join(repo, '.git', 'index')).equals(before));
  });
});

describe('collectSource', () => {
  it('sorts candidates and reports only include-matched skips', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), {
      'docs/z.md': 'z',
      'docs/a.markdown': 'a',
      'docs/.env.md': 'blocked',
      'docs/secret.md': 'blocked',
      'docs/key.pem': 'blocked',
      'docs/note.txt': 'not markdown',
      'docs/big.md': 'x'.repeat(2000),
      'docs/skip/out.md': 'excluded',
      'other/.ssh/config.md': 'outside include',
      'other/c.md': 'outside include',
    });
    const result = collectSource(sourceConfig(repo, { include: ['docs/**'], exclude: ['docs/skip/**'] }));
    assert.equal(result.commit, git(repo, ['rev-parse', 'HEAD']));
    assert.equal(result.requestedRef, 'HEAD');
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ['docs/a.markdown', 'docs/z.md']);
    assert.deepEqual(result.skipped, [
      { path: 'docs/.env.md', reason: 'blocked-path' },
      { path: 'docs/big.md', reason: 'too-large' },
      { path: 'docs/key.pem', reason: 'blocked-path' },
      { path: 'docs/secret.md', reason: 'blocked-path' },
    ]);
    assert.ok(result.tracked.has('other/c.md') && result.tracked.has('docs/note.txt'));
  });

  it('accepts a file exactly at the size limit', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'a.md': 'x'.repeat(1024), 'b.md': 'x'.repeat(1025) });
    const result = collectSource(sourceConfig(repo));
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ['a.md']);
    assert.deepEqual(result.skipped, [{ path: 'b.md', reason: 'too-large' }]);
  });

  it('neither reads nor tracks symlinks and submodules', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'real.md': 'real', 'exec.sh': 'x' });
    const head = git(repo, ['rev-parse', 'HEAD']);
    addIndexEntry(repo, '100755', hashObject(repo, 'run'), 'run.sh');
    addIndexEntry(repo, '120000', hashObject(repo, 'real.md'), 'link.md');
    addIndexEntry(repo, '160000', head, 'sub.md');
    git(repo, ['commit', '-m', 'special']);
    const result = collectSource(sourceConfig(repo));
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ['real.md']);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual([...result.tracked].sort(compareStrings), ['exec.sh', 'real.md', 'run.sh']);
  });

  it('refuses a subdirectory of a repository', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'sub/a.md': 'a', 'other/b.md': 'b' });
    const error = assertKnowledgeError(() => collectSource(sourceConfig(join(repo, 'sub'))), 'source-unavailable');
    assert.equal((error.detail as { reason: string }).reason, 'not-git-toplevel');
  });

  it('refuses a bare repository and a .git directory', (t) => {
    const space = tempSpace(t);
    const repo = makeRepo(space.path('repo'), { 'a.md': 'a' });
    git(space.root, ['clone', '--bare', repo, space.path('bare.git')]);
    for (const path of [space.path('bare.git'), join(repo, '.git')]) {
      const error = assertKnowledgeError(() => collectSource(sourceConfig(path)), 'source-unavailable');
      assert.equal((error.detail as { reason: string }).reason, 'not-git-toplevel', path);
    }
  });

  it('reports an undecodable name only where it would have been a document', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'));
    const head = commitRawNames(repo, [
      { name: 'docs/ok.md', content: '# ok\n' },
      { name: Buffer.from('docs/caf\xe9.md', 'latin1'), content: 'a' },
      { name: Buffer.concat([Buffer.from('docs/한'), Buffer.from([0xff]), Buffer.from('.md')]), content: 'b' },
      { name: Buffer.from('docs/note\xff.txt', 'latin1'), content: 'not markdown' },
      { name: Buffer.from('docs/skip/\xff.md', 'latin1'), content: 'excluded' },
      { name: Buffer.from('other/\xff.md', 'latin1'), content: 'outside include' },
      { name: Buffer.from('docs/link\xff.md', 'latin1'), content: 'ok.md', mode: '120000' },
    ]);
    const result = collectSource(sourceConfig(repo, { include: ['docs/**'], exclude: ['docs/skip/**'] }));
    assert.equal(result.commit, head);
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ['docs/ok.md']);
    assert.deepEqual(result.skipped, [
      { path: 'docs/caf\\xe9.md', reason: 'not-utf8-path' },
      { path: 'docs/한\\xff.md', reason: 'not-utf8-path' },
    ]);
    assert.deepEqual([...result.tracked], ['docs/ok.md']);
  });

  it('keeps an undecodable name under a blocked path as blocked-path so it is never listed', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'));
    commitRawNames(repo, [{ name: Buffer.from('secret/\xff.md', 'latin1'), content: 'a' }]);
    assert.deepEqual(collectSource(sourceConfig(repo)).skipped, [{ path: 'secret/\\xff.md', reason: 'blocked-path' }]);
  });

  it('keeps a leading BOM as part of a file name', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'));
    commitRawNames(repo, [{ name: '﻿a.md', content: 'bom' }, { name: 'a.md', content: 'plain' }]);
    assert.deepEqual(collectSource(sourceConfig(repo)).candidates.map((candidate) => candidate.path).sort(compareStrings), ['a.md', '﻿a.md']);
  });

  it('reads the commit, not the working tree, and honors a ref override', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'a.md': 'one' });
    const first = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['tag', 'v1']);
    const second = commit(repo, { 'a.md': 'two', 'b.md': 'new' });
    writeFiles(repo, { 'c.md': 'uncommitted', 'a.md': 'dirty' });

    const latest = collectSource(sourceConfig(repo));
    assert.equal(latest.commit, second);
    assert.deepEqual(latest.candidates.map((candidate) => candidate.path), ['a.md', 'b.md']);
    assert.equal(readBlobs(repo, latest.candidates).get(latest.candidates[0]!.sha)!.toString(), 'two');

    const pinned = collectSource(sourceConfig(repo), 'v1');
    assert.equal(pinned.commit, first);
    assert.equal(pinned.requestedRef, 'v1');
    assert.deepEqual(pinned.candidates.map((candidate) => candidate.path), ['a.md']);
    assert.ok(!pinned.tracked.has('b.md'));
  });

  it('decodes fatal UTF-8, strips the BOM and classifies NUL as binary', () => {
    assert.deepEqual(decodeBlob(Buffer.from('한글')), { text: '한글' });
    assert.deepEqual(decodeBlob(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), { text: 'A' });
    assert.deepEqual(decodeBlob(Buffer.from([0xff, 0xfe, 0x41])), { reason: 'not-utf8' });
    assert.deepEqual(decodeBlob(Buffer.from([0x41, 0x00, 0x42])), { reason: 'binary' });
    assert.deepEqual(decodeBlob(Buffer.from([0xff, 0x00])), { reason: 'binary' });
  });
});

describe('git child environment', () => {
  function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
    const saved = Object.keys(vars).map((name) => [name, process.env[name]] as const);
    Object.assign(process.env, vars);
    try {
      return fn();
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it('removes every variable git reports as repository-local and keeps the rest', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'));
    const names = git(repo, ['rev-parse', '--local-env-vars']).split(/\r?\n/);
    assert.ok(names.includes('GIT_DIR') && names.includes('GIT_COMMON_DIR'));
    const env = withEnv({ ...Object.fromEntries(names.map((name) => [name, 'inherited'])), AGENT_KNOWLEDGE_TEST_KEEP: 'kept' }, gitChildEnv);
    assert.deepEqual(names.filter((name) => Object.hasOwn(env, name)), []);
    assert.equal(env.AGENT_KNOWLEDGE_TEST_KEEP, 'kept');
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  });

  function twoRepos(t: Parameters<typeof tempSpace>[0]): { own: string; foreign: string; head: string } {
    const space = tempSpace(t);
    const own = makeRepo(space.path('own'), { 'own.md': 'own' });
    return { own, foreign: makeRepo(space.path('foreign'), { 'foreign.md': 'foreign' }), head: git(own, ['rev-parse', 'HEAD']) };
  }

  it('reads the configured repository despite an inherited GIT_DIR', (t) => {
    const { own, foreign, head } = twoRepos(t);
    const result = withEnv({ GIT_DIR: join(foreign, '.git') }, () => collectSource(sourceConfig(own)));
    assert.equal(result.commit, head);
    assert.deepEqual(result.candidates.map((candidate) => candidate.path), ['own.md']);
  });

  it('removes the variable however it is cased on Windows', { skip: process.platform !== 'win32' }, (t) => {
    const { own, foreign, head } = twoRepos(t);
    assert.equal(withEnv({ git_dir: join(foreign, '.git') }, () => collectSource(sourceConfig(own))).commit, head);
  });

  it('builds evaluation fixtures in their own repository despite an inherited GIT_DIR', (t) => {
    const space = tempSpace(t);
    const foreign = makeRepo(space.path('foreign'), { 'foreign.md': 'foreign' });
    const before = git(foreign, ['rev-parse', 'HEAD']);
    const workspace = space.path('workspace');
    writeFiles(workspace, { 'workspace.yaml': "schemaVersion: 1\nsources:\n  - id: fix\n    project: fix\n    include: ['**/*.md']\n", 'fix/a.md': '# 제목\n\n본문\n' });
    const built = withEnv({ GIT_DIR: join(foreign, '.git') }, () => materializeWorkspace(workspace, () => {}));
    t.after(() => built.dispose());
    assert.equal(git(foreign, ['rev-parse', 'HEAD']), before);
    assert.equal(git(built.config.sources[0]!.path, ['rev-list', '--count', 'HEAD']), '1');
  });
});

describe('validateSources', () => {
  function config(sources: SourceConfig[]): SourcesConfig {
    return { schemaVersion: 1, configPath: 'x', database: { path: 'x' }, index: { retainGenerations: 5, maxFileBytes: 1024 }, sources };
  }

  it('reports a bare repository as not-git-toplevel', (t) => {
    const space = tempSpace(t);
    const repo = makeRepo(space.path('repo'), { 'a.md': 'a' });
    git(space.root, ['clone', '--bare', repo, space.path('bare.git')]);
    const report = validateSources(config([sourceConfig(space.path('bare.git'))]));
    assert.deepEqual(report.sources[0]!.errors.map((error) => error.code), ['not-git-toplevel']);
  });

  it('reports a healthy source with its commit and document count', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'a.md': 'a', 'b.txt': 'b' });
    const report = validateSources(config([sourceConfig(repo)]));
    assert.equal(report.ok, true);
    assert.deepEqual(report.sources[0], {
      id: 'src',
      project: 'proj',
      path: repo,
      ref: 'HEAD',
      commit: git(repo, ['rev-parse', 'HEAD']),
      matchedDocuments: 1,
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  it('accepts differently cased paths on Windows', { skip: process.platform !== 'win32' }, (t) => {
    const repo = makeRepo(tempSpace(t).path('Repo'), { 'a.md': 'a' });
    assert.equal(validateSources(config([sourceConfig(repo.toUpperCase())])).ok, true);
  });

  it('collects every failure instead of stopping at the first', (t) => {
    const space = tempSpace(t);
    const repo = makeRepo(space.path('repo'), { 'sub/a.md': 'a' });
    const plain = space.path('plain');
    makeRepo(plain);
    const report = validateSources(config([
      sourceConfig(space.path('missing'), { id: 'missing' }),
      sourceConfig(space.path('repo', 'sub'), { id: 'nested' }),
      sourceConfig(repo, { id: 'bad-ref', ref: 'nope' }),
      sourceConfig(plain, { id: 'unborn' }),
      sourceConfig(repo, { id: 'fine' }),
    ]));
    assert.equal(report.ok, false);
    assert.deepEqual(report.sources.map((source) => [source.id, source.ok, source.errors.map((error) => error.code)]), [
      ['missing', false, ['path-not-found']],
      ['nested', false, ['not-git-toplevel']],
      ['bad-ref', false, ['ref-unresolved']],
      ['unborn', false, ['ref-unresolved']],
      ['fine', true, []],
    ]);
  });

  it('flags a directory that is not a repository', (t) => {
    const space = tempSpace(t);
    const report = validateSources(config([sourceConfig(space.root)]));
    assert.deepEqual(report.sources[0]!.errors.map((error) => error.code), ['not-a-git-repository']);
  });

  it('warns without failing on no documents and on dirty tracked documents', (t) => {
    const repo = makeRepo(tempSpace(t).path('repo'), { 'a.md': 'a' });
    const empty = validateSources(config([sourceConfig(repo, { include: ['none/**'] })]));
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.sources[0]!.warnings.map((warning) => warning.code), ['no-matching-documents']);

    writeFiles(repo, { 'a.md': 'dirty' });
    const dirty = validateSources(config([sourceConfig(repo)]));
    assert.equal(dirty.ok, true);
    assert.deepEqual(dirty.sources[0]!.warnings.map((warning) => warning.code), ['dirty-tracked-documents']);
  });
});
