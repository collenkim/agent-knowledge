export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '?') source += '[^/]';
    else if (char !== '*') source += char.replace(/[\\^$.+()[\]{}|/]/, '\\$&');
    else if (glob[i + 1] !== '*') source += '[^/]*';
    else if (glob[i + 2] === '/') {
      // `**/`는 경로 마디 0개와도 일치해야 `docs/**/*.md`가 `docs/a.md`를 포함한다
      source += '(?:[^/]+/)*';
      i += 2;
    } else {
      source += '.*';
      i += 1;
    }
  }
  return new RegExp(`^${source}$`, 'su');
}

export function matchesGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

export function pathsOverlap(taskPath: string, itemPath: string): boolean {
  if (taskPath === itemPath || matchesGlob(itemPath, taskPath)) return true;
  if (itemPath.endsWith('/')) return taskPath.startsWith(itemPath);
  return !/[*?]/.test(itemPath) && taskPath.startsWith(`${itemPath}/`);
}
