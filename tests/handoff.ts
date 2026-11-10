import { join } from 'node:path';
import { z } from 'zod';
import { compareStrings } from '../src/util/compare.js';
import { canonicalJson, sha256 } from '../src/util/hash.js';
import { CONTRACT_DIR, loadJson, scenarioSchema } from './contract.js';

/**
 * docs/contract/handoff-cases.json을 읽는 참조 구현이다. 생산자 코드가 아니라 계약 문서를 시험하려고 둔다.
 * 수신은 꼴·형식 검사(parseHandoff), 접수 범위 검사(submitScope), 생산자 확인(checkOf)의 세 단계이고, 송신 결정(decideSend)과 함께 docs/integration.md를 따른다.
 * 바이트 상한은 형식 1에도 건다. code-agent 3c5bbac는 검사하지 않지만 보내는 쪽은 지킨다.
 */

export const HANDOFF_CASES = join(CONTRACT_DIR, 'handoff-cases.json');
export const MAX_REFS = 20;
export const MAX_BYTES = 32 * 1024;

const CONTROL = /\p{Cc}/u;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const INDEX_ID = /^[0-9a-f]{32}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HANDLE = /^[A-Za-z0-9_.:-]{1,64}$/;
const V1_KEYS = ['itemId', 'generation', 'commit', 'itemSha256', 'required'];
const V2_REQUIRED = ['indexId', 'indexGeneration', 'itemId', 'itemSha256', 'commit', 'sourceId', 'path', 'startLine', 'endLine'];
const V2_OPTIONAL = ['handle', 'projectId', 'documentSha256', 'blobSha'];
const SEGMENT_KEYS = ['segmentId', 'segmentSha256', 'segmentStartLine', 'segmentEndLine'];
const V2_KEYS = [...V2_REQUIRED, ...SEGMENT_KEYS, ...V2_OPTIONAL, 'required'];

export type Ref = Record<string, unknown> & { itemId: string; segmentId?: string; required: boolean };
export type Parsed = { accepted: true; version: number; refs: Ref[] } | { accepted: false; code: 'invalid-request'; reason: string };

/** 수신 거절 사유. problem은 송신 쪽이 미리 거를 때 쓰는 더 자세한 이름이다(master-agent handoff.mjs와 같은 이름). */
class Rejected extends Error {
  constructor(
    readonly reason: string,
    readonly problem = 'format',
  ) {
    super(reason);
  }
}

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const absent = (value: unknown): boolean => value === undefined || value === null;

function itemIdOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.trim() === '' || CONTROL.test(value) || !value.includes(':') || !value.includes('#')) {
    throw new Rejected('knowledge-format', 'item-id-format');
  }
  return value;
}

function safeRelative(path: string): boolean {
  if (path === '' || path.length > 512 || path.includes('\\') || CONTROL.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function refV1(item: Record<string, unknown>): Ref {
  const fail = (problem: string): never => {
    throw new Rejected('knowledge-format', problem);
  };
  if (Object.keys(item).some((key) => !V1_KEYS.includes(key))) fail('unknown-field');
  const itemId = itemIdOf(item.itemId);
  const { generation, commit, itemSha256, required } = item;
  if (!positive(generation)) fail('generation-format');
  if (typeof commit !== 'string' || !HEX40.test(commit)) fail('commit-format');
  if (typeof itemSha256 !== 'string' || !HEX64.test(itemSha256)) fail('item-hash-format');
  if (required !== undefined && typeof required !== 'boolean') fail('required-format');
  return { itemId, generation, commit, itemSha256, required: (required as boolean | undefined) ?? true };
}

function refV2(item: Record<string, unknown>): Ref {
  const fail = (problem: string): never => {
    throw new Rejected('knowledge-format', problem);
  };
  if (Object.keys(item).some((key) => !V2_KEYS.includes(key))) fail('unknown-field');
  if (V2_REQUIRED.some((key) => absent(item[key]))) fail('missing-field');
  const itemId = itemIdOf(item.itemId);
  const { indexId, indexGeneration, itemSha256, commit, sourceId, path, startLine, endLine } = item;
  if (typeof indexId !== 'string' || !INDEX_ID.test(indexId)) fail('index-id-format');
  if (!positive(indexGeneration)) fail('generation-format');
  if (typeof itemSha256 !== 'string' || !HEX64.test(itemSha256)) fail('item-hash-format');
  if (typeof commit !== 'string' || !GIT_SHA.test(commit)) fail('commit-format');
  if (typeof sourceId !== 'string' || !NAME.test(sourceId) || typeof path !== 'string' || !safeRelative(path)) fail('source-path-format');
  if (!itemId.startsWith(`${sourceId as string}:${path as string}#`)) fail('source-path-format');
  if (!positive(startLine) || !positive(endLine) || startLine > endLine) fail('line-range-format');
  const out: Ref = { indexId, indexGeneration, itemId, itemSha256, commit, sourceId, path, startLine, endLine, required: true };
  const { segmentId, segmentSha256, segmentStartLine, segmentEndLine } = item;
  if (absent(segmentId)) {
    if (![segmentSha256, segmentStartLine, segmentEndLine].every(absent)) fail('segment-format');
  } else {
    if (typeof segmentId !== 'string' || segmentId.length > 600 || CONTROL.test(segmentId) || !segmentId.startsWith(`${itemId}#`)) fail('segment-format');
    if (typeof segmentSha256 !== 'string' || !HEX64.test(segmentSha256)) fail('segment-format');
    if (!positive(segmentStartLine) || !positive(segmentEndLine) || segmentStartLine > segmentEndLine || segmentStartLine < (startLine as number) || segmentEndLine > (endLine as number)) fail('segment-format');
    Object.assign(out, { segmentId, segmentSha256, segmentStartLine, segmentEndLine });
  }
  if (item.handle !== undefined && (typeof item.handle !== 'string' || !HANDLE.test(item.handle))) fail('handle-format');
  if (item.projectId !== undefined && (typeof item.projectId !== 'string' || !NAME.test(item.projectId))) fail('source-path-format');
  if (item.documentSha256 !== undefined && (typeof item.documentSha256 !== 'string' || !HEX64.test(item.documentSha256))) fail('document-hash-format');
  if (item.blobSha !== undefined && (typeof item.blobSha !== 'string' || !GIT_SHA.test(item.blobSha))) fail('blob-format');
  for (const key of V2_OPTIONAL) if (item[key] !== undefined) out[key] = item[key];
  if (item.required !== undefined && typeof item.required !== 'boolean') fail('required-format');
  out.required = (item.required as boolean | undefined) ?? true;
  return out;
}

export const refKey = (ref: { itemId: string; segmentId?: string | null }): string => `${ref.itemId}\u0000${ref.segmentId ?? ''}`;

/** submit.payload.knowledge의 꼴·형식 검사. receiverVersions는 수신자가 hello `refs.versions`로 공지한 형식이다. */
export function parseHandoff(raw: unknown, receiverVersions: readonly number[]): Parsed {
  try {
    if (!plain(raw)) throw new Rejected('knowledge-format');
    if (Object.keys(raw).some((key) => key !== 'version' && key !== 'refs')) throw new Rejected('knowledge-format');
    const version = raw.version;
    if ((version !== 1 && version !== 2) || !receiverVersions.includes(version)) throw new Rejected('knowledge-version');
    if (!Array.isArray(raw.refs) || raw.refs.length < 1 || raw.refs.length > MAX_REFS) throw new Rejected('knowledge-limit');
    if (Buffer.byteLength(canonicalJson(raw), 'utf8') > MAX_BYTES) throw new Rejected('knowledge-too-large');
    const seen = new Set<string>();
    const refs = (raw.refs as unknown[]).map((item) => {
      if (!plain(item)) throw new Rejected('knowledge-format');
      const ref = version === 1 ? refV1(item) : refV2(item);
      const key = version === 1 ? ref.itemId : refKey(ref);
      if (seen.has(key)) throw new Rejected('knowledge-duplicate');
      seen.add(key);
      return ref;
    });
    return { accepted: true, version, refs };
  } catch (error) {
    if (error instanceof Rejected) return { accepted: false, code: 'invalid-request', reason: error.reason };
    throw error;
  }
}

/** 인계의 정본 해시. 참조 순서는 보지 않는다. */
export function handoffDigest(version: number, refs: readonly Ref[]): string {
  const sorted = [...refs].sort((a, b) => compareStrings(refKey(a), refKey(b)));
  return `sha256:${sha256(canonicalJson({ version, refs: sorted }))}`;
}

/** 받는 쪽의 수신 범위. docs는 등록 문서 경로, project·sources는 어댑터 설정이 이 저장소에 대응시킨 생산자 프로젝트·원본이다. */
export interface Receiver {
  project: string;
  sources: readonly string[];
  docs: readonly string[];
}

export interface OutsideRef {
  itemId: string;
  segmentId?: string;
  reason: 'not-in-docs' | 'out-of-scope';
}

export type Submitted = { accepted: true } | { accepted: false; code: 'invalid-request'; reason: 'knowledge-scope'; refs: OutsideRef[] };

/** 형식 1 참조의 원본 경로는 항목 ID의 `<원본>:` 뒤 첫 `#` 앞이다. */
function pathOf(ref: Ref): string {
  if (typeof ref.path === 'string') return ref.path;
  const colon = ref.itemId.indexOf(':');
  const hash = ref.itemId.indexOf('#', colon + 1);
  return colon >= 0 && hash > colon ? ref.itemId.slice(colon + 1, hash) : '';
}

/** 접수 범위 검사. 참조 하나라도 범위 밖이면 인계 전체를 거절한다. 선택 참조도 같다. */
export function submitScope(refs: readonly Ref[], receiver: Receiver): Submitted {
  const docs = new Set(receiver.docs);
  const outside: OutsideRef[] = [];
  for (const ref of refs) {
    const source = typeof ref.sourceId === 'string' ? ref.sourceId : ref.itemId.slice(0, ref.itemId.indexOf(':'));
    const reason = !docs.has(pathOf(ref)) ? 'not-in-docs' : !receiver.sources.includes(source) || (ref.projectId !== undefined && ref.projectId !== receiver.project) ? 'out-of-scope' : undefined;
    if (reason) outside.push({ itemId: ref.itemId, ...(ref.segmentId ? { segmentId: ref.segmentId } : {}), reason });
  }
  return outside.length === 0 ? { accepted: true } : { accepted: false, code: 'invalid-request', reason: 'knowledge-scope', refs: outside.slice(0, MAX_REFS) };
}

export type Cause = 'unverified' | 'hash-mismatch' | 'identity-mismatch' | 'expired' | 'source-changed' | 'source-deleted' | 'scope' | 'adapter';
export type Recovery = 'reverify' | 'replan';

/** 사유 → 원인 갈래·회복. docs/integration.md의 판정 표다. */
export const REASONS: Readonly<Record<string, readonly [Cause, Recovery]>> = {
  'not-verified': ['unverified', 'reverify'],
  'verification-expired': ['expired', 'reverify'],
  'hash-mismatch': ['hash-mismatch', 'replan'],
  'commit-mismatch': ['identity-mismatch', 'replan'],
  'index-mismatch': ['identity-mismatch', 'replan'],
  'generation-expired': ['expired', 'replan'],
  'range-mismatch': ['source-changed', 'replan'],
  'content-changed': ['source-changed', 'replan'],
  ambiguous: ['source-changed', 'replan'],
  'missing-file': ['source-deleted', 'replan'],
  'not-found': ['scope', 'replan'],
  'out-of-scope': ['scope', 'replan'],
  'not-in-docs': ['scope', 'replan'],
  'adapter-failed': ['adapter', 'reverify'],
};

/** 생산자 verify의 판정을 사유로 옮긴다. 여러 필드가 어긋나면 해시, 조각, 원본 판, 범위 순으로 하나를 고른다. */
export function reasonOf(verdict: string, mismatches: readonly string[]): string | undefined {
  const has = (...fields: string[]): boolean => mismatches.some((field) => fields.includes(field));
  switch (verdict) {
    case 'intact':
      return undefined;
    case 'other-index':
      return 'index-mismatch';
    case 'generation-missing':
      return 'generation-expired';
    case 'not-found':
      return 'not-found';
    case 'mismatch':
      if (has('itemSha256', 'segmentSha256')) return 'hash-mismatch';
      if (has('segmentId')) return 'not-found';
      if (has('commit', 'blobSha', 'documentSha256')) return 'commit-mismatch';
      if (has('sourceId', 'projectId')) return 'out-of-scope';
      return 'range-mismatch';
    default:
      throw new Error(`unknown verdict: ${verdict}`);
  }
}

export type Check = { cause: 'verified' } | { cause: Cause; reason: string; recovery: Recovery };

/** 사례 파일의 판정 표기. 확인된 참조는 원인이 아니라 `verified`로 적는다(진행 게이트 상태와 같은 이름). */
export function checkOf(verdict: string, mismatches: readonly string[]): Check {
  const reason = reasonOf(verdict, mismatches);
  if (reason === undefined) return { cause: 'verified' };
  const judged = REASONS[reason];
  if (!judged) throw new Error(`unmapped reason: ${reason}`);
  return { reason, cause: judged[0], recovery: judged[1] };
}

export interface Gate {
  state: 'verified' | 'blocked';
  action?: 'knowledge-reverify' | 'knowledge-replan';
}

/** 진행 게이트. required 참조가 하나라도 확인되지 않으면 막고, 회복에 재계획이 하나라도 있으면 재계획이다. */
export function gateOf(refs: readonly { required: boolean; check: Check }[]): Gate {
  const blocked = refs.filter((ref) => ref.required && ref.check.cause !== 'verified');
  if (blocked.length === 0) return { state: 'verified' };
  return { state: 'blocked', action: blocked.some((ref) => 'recovery' in ref.check && ref.check.recovery === 'replan') ? 'knowledge-replan' : 'knowledge-reverify' };
}

/** 보낼 후보 하나. ref는 생산자 형식 2의 `ref` 17개 필드이고 role은 master 묶음에서의 자리(자기 프로젝트·허용 연결)다. */
export interface Candidate {
  ref: Record<string, unknown>;
  required: boolean;
  role: 'project' | 'link';
}

export interface Sent {
  itemId: string;
  segmentId?: string;
  required: boolean;
}

export interface Omitted {
  itemId: string;
  segmentId?: string;
  reason: string;
}

export interface SendDecision {
  action: 'send' | 'hold' | 'omit' | 'none';
  version?: number;
  reason?: string;
  refs?: Sent[];
  omitted?: Omitted[];
  digest?: string;
  payload?: { version: number; refs: Record<string, unknown>[] };
}

const idOf = (ref: Record<string, unknown>): { itemId: string; segmentId?: string } => ({
  itemId: ref.itemId as string,
  ...(typeof ref.segmentId === 'string' ? { segmentId: ref.segmentId } : {}),
});

/** 생산자 `ref`를 인계 형식의 참조로 바꾼다. 형식 1은 항목 단위라 조각도 부모 항목 참조가 된다. 값이 없는 선택 필드는 싣지 않는다. */
function wireOf(ref: Record<string, unknown>, version: number, required: boolean): Record<string, unknown> {
  if (version === 1) return { itemId: ref.itemId, generation: ref.indexGeneration, commit: ref.commit, itemSha256: ref.itemSha256, required };
  const wire: Record<string, unknown> = {};
  for (const key of [...V2_REQUIRED, ...(absent(ref.segmentId) ? [] : SEGMENT_KEYS), ...V2_OPTIONAL]) if (!absent(ref[key])) wire[key] = ref[key];
  wire.required = required;
  return wire;
}

function problemOf(wire: Record<string, unknown>, version: number): string | undefined {
  try {
    if (version === 1) refV1(wire);
    else refV2(wire);
    return undefined;
  } catch (error) {
    if (error instanceof Rejected) return error.problem;
    throw error;
  }
}

/**
 * master의 송신 결정(docs/integration.md 「송신 결정」). required 참조는 형식 2와 진행 게이트를 함께 공지한 수신자에게만 보내고,
 * 보낼 수 없으면 그 작업을 보류한다. 선택 참조는 보낼 수 없으면 사유와 함께 뺀다. 받는 쪽 범위를 넓히지 않는다.
 */
export function decideSend(knowledge: unknown, senderVersions: readonly number[], candidates: readonly Candidate[]): SendDecision {
  if (candidates.length === 0) return { action: 'none' };
  const required = candidates.some((candidate) => candidate.required);
  const all = (reason: string): Omitted[] => candidates.map((candidate) => ({ ...idOf(candidate.ref), reason }));
  const unusable = (reason: string): SendDecision => (required ? { action: 'hold', reason } : { action: 'omit', reason, omitted: all(reason) });
  const refs = plain(knowledge) && plain(knowledge.refs) ? knowledge.refs : undefined;
  if (!refs || refs.supported !== true || !positive(refs.max)) return unusable('knowledge-handoff-unsupported');
  if (refs.accepted !== true) return unusable('knowledge-handoff-not-accepted');
  const versions = Array.isArray(refs.versions) ? refs.versions.filter(positive) : [1];
  const common = versions.filter((version) => senderVersions.includes(version));
  let version: number;
  if (required) {
    if (refs.requiredGate !== true) return { action: 'hold', reason: 'knowledge-handoff-ungated' };
    if (!common.includes(2)) return { action: 'hold', reason: 'knowledge-handoff-version' };
    version = 2;
  } else {
    if (common.length === 0) return unusable('knowledge-handoff-version');
    version = Math.max(...common);
  }
  const max = Math.min(refs.max, MAX_REFS);
  const maxBytes = positive(refs.maxBytes) ? refs.maxBytes : MAX_BYTES;

  const omitted: Omitted[] = [];
  const entries: { id: { itemId: string; segmentId?: string }; wire: Record<string, unknown>; required: boolean }[] = [];
  for (const candidate of candidates) {
    const id = idOf(candidate.ref);
    if (candidate.role !== 'project') {
      if (candidate.required) return { action: 'hold', reason: 'knowledge-handoff-scope' };
      omitted.push({ ...id, reason: 'receiver-scope' });
      continue;
    }
    const wire = wireOf(candidate.ref, version, candidate.required);
    const problem = problemOf(wire, version);
    if (problem) {
      if (candidate.required) return { action: 'hold', reason: 'knowledge-handoff-unrepresentable' };
      omitted.push({ ...id, reason: problem });
      continue;
    }
    const key = version === 1 ? (wire.itemId as string) : refKey(wire as Ref);
    const same = entries.find((entry) => (version === 1 ? (entry.wire.itemId as string) : refKey(entry.wire as Ref)) === key);
    if (same) {
      // 형식 1에서 같은 항목의 조각은 부모 항목 참조 하나로 합친다. 하나라도 required면 required다
      const { required: _left, ...left } = same.wire;
      const { required: _right, ...right } = wire;
      if (canonicalJson(left) !== canonicalJson(right)) {
        if (candidate.required || same.required) return { action: 'hold', reason: 'knowledge-handoff-unrepresentable' };
        omitted.push({ ...id, reason: 'item-id-collision' });
        continue;
      }
      if (candidate.required && !same.required) {
        same.required = true;
        same.wire = { ...same.wire, required: true };
      }
      continue;
    }
    entries.push({ id: version === 1 ? { itemId: wire.itemId as string } : id, wire, required: candidate.required });
  }
  const bytesOf = (list: readonly { wire: Record<string, unknown> }[]): number => Buffer.byteLength(canonicalJson({ version, refs: list.map((entry) => entry.wire) }), 'utf8');
  const needed = entries.filter((entry) => entry.required);
  if (needed.length > max || (needed.length > 0 && bytesOf(needed) > maxBytes)) return { action: 'hold', reason: 'knowledge-handoff-limit' };
  let chosen = [...needed, ...entries.filter((entry) => !entry.required)];
  while (chosen.length > max || bytesOf(chosen) > maxBytes) {
    const drop = chosen.findLast((entry) => !entry.required)!;
    omitted.push({ ...drop.id, reason: 'receiver-limit' });
    chosen = chosen.filter((entry) => entry !== drop);
  }
  if (chosen.length === 0) return { action: 'omit', reason: 'no-sendable-refs', omitted };
  const payload = { version, refs: chosen.map((entry) => entry.wire) };
  const parsed = parseHandoff(payload, [version]);
  if (!parsed.accepted) throw new Error(`send decision built a payload the receiver rejects: ${parsed.reason}`);
  return {
    action: 'send',
    version,
    refs: chosen.map((entry) => ({ ...entry.id, required: entry.required })),
    omitted,
    digest: handoffDigest(version, parsed.refs),
    payload,
  };
}

const causeSchema = z.enum(['verified', 'unverified', 'hash-mismatch', 'identity-mismatch', 'expired', 'source-changed', 'source-deleted', 'scope', 'adapter']);
const idSchema = { itemId: z.string(), segmentId: z.string().optional() };

const verificationRefSchema = z.strictObject({
  itemId: z.string(),
  segmentId: z.string().nullable(),
  required: z.boolean(),
  cause: causeSchema,
  reason: z.string().optional(),
  recovery: z.enum(['reverify', 'replan']).optional(),
  mismatches: z.array(z.string()),
});

const caseSchema = z.strictObject({
  id: z.string().min(1),
  note: z.string().optional(),
  receiverVersions: z.array(z.number().int()).min(1),
  knowledge: z.unknown(),
  expect: z.union([
    z.strictObject({ accepted: z.literal(true), refs: z.array(z.record(z.string(), z.unknown())).min(1), digest: z.string().optional() }),
    z.strictObject({ accepted: z.literal(false), code: z.literal('invalid-request'), reason: z.string().min(1) }),
  ]),
  submit: z
    .strictObject({
      accepted: z.literal(false),
      code: z.literal('invalid-request'),
      reason: z.literal('knowledge-scope'),
      refs: z.array(z.strictObject({ ...idSchema, reason: z.enum(['not-in-docs', 'out-of-scope']) })).min(1),
    })
    .optional(),
  verification: z
    .strictObject({
      refs: z.array(verificationRefSchema).min(1),
      progress: z.enum(['allowed', 'blocked']),
      gate: z.strictObject({ state: z.enum(['verified', 'blocked']), action: z.enum(['knowledge-reverify', 'knowledge-replan']).optional() }),
    })
    .optional(),
});

const helloSchema = z.strictObject({
  id: z.string().min(1),
  note: z.string().optional(),
  knowledge: z.unknown(),
  senderVersions: z.array(z.number().int()).min(1),
  refs: z.array(z.strictObject({ use: z.string().min(1), required: z.boolean(), role: z.enum(['project', 'link']) })),
  expect: z.strictObject({
    action: z.enum(['send', 'hold', 'omit', 'none']),
    version: z.number().int().optional(),
    reason: z.string().optional(),
    refs: z.array(z.strictObject({ ...idSchema, required: z.boolean() })).optional(),
    omitted: z.array(z.strictObject({ ...idSchema, reason: z.string() })).optional(),
    digest: z.string().optional(),
  }),
});

export const handoffCasesSchema = z.strictObject({
  schema: z.literal('agent-knowledge.handoff-cases'),
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  contract: z.literal('code-agent.master submit.payload.knowledge'),
  status: z.record(z.string(), z.string()),
  notes: z.array(z.string()),
  fixture: scenarioSchema.shape.fixture,
  receiver: z.strictObject({
    profile: z.literal('code'),
    scope: z.strictObject({ projects: z.array(z.string()).length(1) }),
    project: z.string().min(1),
    sources: z.array(z.string()).min(1),
    docs: z.array(z.string()).min(1),
  }),
  limits: z.strictObject({ maxRefs: z.literal(MAX_REFS), maxBytes: z.literal(MAX_BYTES) }),
  refPool: z.record(z.string(), z.record(z.string(), z.unknown())),
  hello: z.array(helloSchema).min(1),
  cases: z.array(caseSchema).min(1),
});

export type HandoffCases = z.infer<typeof handoffCasesSchema>;

export function loadHandoffCases(): HandoffCases {
  return handoffCasesSchema.parse(loadJson(HANDOFF_CASES));
}
