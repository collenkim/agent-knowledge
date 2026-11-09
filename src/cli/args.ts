import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { KnowledgeError } from '../errors.js';

export const COMMANDS = ['validate', 'index', 'status', 'search', 'get', 'eval'] as const;
export type Command = (typeof COMMANDS)[number];

export type Values = Record<string, string | string[] | boolean | undefined>;
type ParsedCommandLine = { help: true } | { help: false; command: Command; values: Values };

interface OptionSpec {
  type: 'string' | 'boolean';
  multiple?: boolean;
  short?: string;
}

const text: OptionSpec = { type: 'string' };
const many: OptionSpec = { type: 'string', multiple: true };

const SHARED: Record<string, OptionSpec> = {
  config: text,
  'retrieval-config': text,
  db: text,
  pretty: { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const SCOPE: Record<string, OptionSpec> = { profile: text, project: many, 'allow-link': many, generation: text, commit: many, request: text };

const OPTIONS: Record<Command, Record<string, OptionSpec>> = {
  validate: {},
  index: { ref: many },
  status: {},
  search: { ...SCOPE, query: text, kind: many, status: many, phase: text, path: many, limit: text },
  get: { ...SCOPE, id: text },
  eval: { suite: many },
};

export const HELP = `agent-knowledge <명령> [옵션]

명령:
  validate   수집 설정과 검색 설정을 검사합니다
  index      등록된 원본을 색인합니다 [--ref <원본>=<리비전>]...
  status     색인 상태를 조회합니다
  search     근거를 검색합니다
             --profile master|code --project <ID>... [--query <문장>] [--path <경로>]...
             [--allow-link <프로젝트>[:종류[,종류]]]... [--kind <종류>]... [--status <상태>]...
             [--generation <세대>] [--commit <원본>=<SHA>]... [--phase <단계>] [--limit <개수>]
             또는 --request <파일|->
  get        항목 하나를 조회합니다
             --id <ID> --profile master|code --project <ID>... [--allow-link ...]
             [--generation <세대>] [--commit <원본>=<SHA>]... 또는 --request <파일|->
  eval       평가 묶음을 실행합니다 [--suite <파일|디렉터리>]...

공통 옵션:
  --config <경로>            원본 설정 (환경변수 AGENT_KNOWLEDGE_CONFIG)
  --retrieval-config <경로>  검색 설정 (환경변수 AGENT_KNOWLEDGE_RETRIEVAL_CONFIG)
  --db <경로>                색인 DB (환경변수 AGENT_KNOWLEDGE_DB)
  --pretty                   JSON을 들여 써서 출력합니다
  --quiet                    진행 메시지를 출력하지 않습니다

결과는 stdout에 JSON 문서 하나로, 진행 상황과 진단은 stderr로 출력합니다.
`;

function usage(message: string, detail?: Record<string, unknown>): KnowledgeError {
  return new KnowledgeError('usage', message, detail);
}

function isCommand(value: string | undefined): value is Command {
  return (COMMANDS as readonly (string | undefined)[]).includes(value);
}

export function knownCommand(argv: readonly string[]): Command | null {
  return isCommand(argv[0]) ? argv[0] : null;
}

export function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const first = argv[0];
  if (first === 'help' || first === '--help' || first === '-h') return { help: true };
  if (first === undefined) throw usage('명령을 지정해 주십시오', { commands: COMMANDS });
  if (!isCommand(first)) throw usage(`알 수 없는 명령입니다: ${first}`, { commands: COMMANDS });

  let values: Values;
  try {
    values = parseArgs({ args: argv.slice(1), options: { ...SHARED, ...OPTIONS[first] }, strict: true, allowPositionals: false }).values as Values;
  } catch (error) {
    if (!String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')) throw error;
    throw usage((error as Error).message);
  }
  return values.help ? { help: true } : { help: false, command: first, values };
}

export function single(values: Values, name: string): string | undefined {
  return values[name] as string | undefined;
}

export function list(values: Values, name: string): string[] {
  return (values[name] as string[] | undefined) ?? [];
}

function parsePair(raw: string, flag: string): [string, string] {
  const separator = raw.indexOf('=');
  if (separator <= 0 || separator === raw.length - 1) throw usage(`--${flag} 값은 <이름>=<값> 형식이어야 합니다: ${raw}`, { flag, value: raw });
  return [raw.slice(0, separator), raw.slice(separator + 1)];
}

export function parsePairs(values: Values, flag: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const raw of list(values, flag)) {
    const [name, value] = parsePair(raw, flag);
    if (pairs.has(name)) throw usage(`--${flag}에 같은 이름을 두 번 지정했습니다: ${name}`, { flag, name });
    pairs.set(name, value);
  }
  return pairs;
}

function parseInteger(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) throw usage(`--${flag} 값은 정수여야 합니다: ${raw}`, { flag, value: raw });
  return Number(raw);
}

function parseAllowLink(raw: string): { project: string; kinds?: string[] } {
  const colon = raw.indexOf(':');
  if (colon === 0 || raw === '') throw usage(`--allow-link 값이 올바르지 않습니다: ${raw}`, { flag: 'allow-link', value: raw });
  if (colon < 0) return { project: raw };
  return { project: raw.slice(0, colon), kinds: raw.slice(colon + 1).split(',').filter(Boolean) };
}

function readRequestFile(path: string): unknown {
  let body: string;
  try {
    body = readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch (error) {
    throw new KnowledgeError('invalid-request', `요청 파일을 읽을 수 없습니다: ${path}`, { reason: 'request-unreadable', path, errno: (error as NodeJS.ErrnoException).code ?? null });
  }
  try {
    return JSON.parse(body.replace(/^﻿/, ''));
  } catch (error) {
    throw new KnowledgeError('invalid-request', `요청 파일이 올바른 JSON이 아닙니다: ${path}`, { reason: 'request-not-json', path, message: (error as Error).message });
  }
}

/** `--request`를 쓰면 요청 전체가 파일에서 오므로 나머지 요청 옵션과 섞을 수 없다. */
function requestFileOr(values: Values, flags: readonly string[]): unknown {
  const path = single(values, 'request');
  if (path === undefined) return undefined;
  const mixed = flags.filter((flag) => values[flag] !== undefined);
  if (mixed.length > 0) throw usage('--request는 다른 요청 옵션과 함께 쓸 수 없습니다', { flags: mixed });
  return readRequestFile(path);
}

function required(values: Values, name: string): string {
  const value = single(values, name);
  if (value === undefined) throw usage(`--${name}이(가) 필요합니다`, { flag: name });
  return value;
}

function scopeOf(values: Values): { projects: string[]; allowedLinks?: { project: string; kinds?: string[] }[] } {
  const projects = list(values, 'project');
  if (projects.length === 0) throw usage('--project를 하나 이상 지정해 주십시오', { flag: 'project' });
  const links = list(values, 'allow-link').map(parseAllowLink);
  return links.length > 0 ? { projects, allowedLinks: links } : { projects };
}

function versionOf(values: Values): { version?: { generation?: number; commits?: Record<string, string> } } {
  const generation = single(values, 'generation');
  const commits = parsePairs(values, 'commit');
  if (generation === undefined && commits.size === 0) return {};
  return {
    version: {
      ...(generation === undefined ? {} : { generation: parseInteger(generation, 'generation') }),
      ...(commits.size === 0 ? {} : { commits: Object.fromEntries(commits) }),
    },
  };
}

export function searchRequestOf(values: Values): unknown {
  const fromFile = requestFileOr(values, ['profile', 'project', 'allow-link', 'generation', 'commit', 'query', 'kind', 'status', 'phase', 'path', 'limit']);
  if (fromFile !== undefined) return fromFile;

  const query = single(values, 'query');
  const paths = list(values, 'path');
  const profile = required(values, 'profile');
  if (query === undefined && paths.length === 0) throw usage('--query 또는 --path 중 하나는 필요합니다');
  const kinds = list(values, 'kind');
  const statuses = list(values, 'status');
  const phase = single(values, 'phase');
  const limit = single(values, 'limit');
  return {
    profile,
    ...(query === undefined ? {} : { query }),
    scope: scopeOf(values),
    ...(kinds.length > 0 || statuses.length > 0 ? { filters: { ...(kinds.length > 0 ? { kinds } : {}), ...(statuses.length > 0 ? { statuses } : {}) } } : {}),
    ...versionOf(values),
    ...(phase !== undefined || paths.length > 0 ? { task: { ...(phase === undefined ? {} : { phase }), ...(paths.length > 0 ? { paths } : {}) } } : {}),
    ...(limit === undefined ? {} : { limit: parseInteger(limit, 'limit') }),
  };
}

export function getRequestOf(values: Values): unknown {
  const fromFile = requestFileOr(values, ['id', 'profile', 'project', 'allow-link', 'generation', 'commit']);
  if (fromFile !== undefined) return fromFile;
  return { id: required(values, 'id'), profile: required(values, 'profile'), scope: scopeOf(values), ...versionOf(values) };
}
