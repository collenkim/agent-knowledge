/** 저장소 기준 상대 경로로 정규화한다. 저장소 밖을 가리키는 경로는 null이다. */
export function normalizeRepoPath(input: string): string | null {
  const path = input.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  return path.split('/').includes('..') ? null : path;
}
