const BLOCKED_SEGMENT = /^(?:\.git|\.master-agent|\.code-agent|\.codex|\.claude|\.aws|\.ssh|node_modules|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|auth\.json)$/i;
const DENIED_EXTENSION = /\.(?:pem|key|p12|pfx|db|sqlite|exe|dll|zip)$/i;
const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/i;

export function isBlockedPath(path: string): boolean {
  return DENIED_EXTENSION.test(path) || path.split('/').some((segment) => BLOCKED_SEGMENT.test(segment));
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSION.test(path);
}
