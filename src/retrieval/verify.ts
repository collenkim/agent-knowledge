import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { KnowledgeError } from '../errors.js';
import { EFFECTIVE_STATUSES, type EffectiveStatus } from '../model.js';
import { compareStrings } from '../util/compare.js';
import { appliedScopeOf, CONFIRMED, NOTICE } from './compose.js';
import { all, inEffectiveScope, parseScope, selectItems, withGeneration, type EffectiveScope, type ScopedItem } from './scope.js';
import type { AppliedScope, RetrievalContext } from './types.js';
import type { SegmentRow } from './units.js';

export const MAX_REFERENCES = 256;
const MAX_CANDIDATES = 5;
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);

/** 넘겨받은 참조의 최소 필드. 나머지 필드(path, commit 등)는 있으면 함께 대조한다. 조각 ID와 조각 해시는 함께 와야 한다. */
const referenceFields = z.looseObject({
  indexId: z.string().nullable(),
  indexGeneration: z.number().int().positive(),
  itemId: z.string().min(1),
  itemSha256: SHA256,
  segmentId: z.string().min(1).nullable().optional(),
  segmentSha256: SHA256.nullable().optional(),
  sourceId: z.string().optional(),
  projectId: z.string().optional(),
  commit: z.string().optional(),
  documentSha256: SHA256.optional(),
  blobSha: z.string().optional(),
  path: z.string().optional(),
  startLine: z.number().int().optional(),
  endLine: z.number().int().optional(),
  segmentStartLine: z.number().int().nullable().optional(),
  segmentEndLine: z.number().int().nullable().optional(),
  handle: z.string().optional(),
});
// 해시 없이 조각 ID만 받으면 같은 조각도 바뀐 것으로 보고하게 된다
const referenceSchema = referenceFields.refine((ref) => (ref.segmentId ?? null) === null || typeof ref.segmentSha256 === 'string', {
  message: 'segmentId에는 segmentSha256이 함께 있어야 합니다',
  path: ['segmentSha256'],
});

const requestSchema = z.strictObject({
  profile: z.enum(['master', 'code']),
  scope: z.unknown(),
  references: z.array(referenceSchema).min(1).max(MAX_REFERENCES),
  against: z.strictObject({ generation: z.number().int().positive().optional() }).optional(),
});

type Reference = z.infer<typeof referenceSchema>;

export interface KnowledgeState {
  status: EffectiveStatus;
  confirmed: boolean;
}

export interface VerifyResult {
  position: number;
  handle: string | null;
  itemId: string;
  /** 참조가 가리킨 세대에서 참조가 그대로인지. 승인이나 검증 결과가 아니라 참조 무결성만 본다. */
  reference: {
    verdict: 'intact' | 'mismatch' | 'not-found' | 'generation-missing' | 'other-index';
    mismatches: string[];
    knowledge: KnowledgeState | null;
  };
  /** 비교 대상 세대(기본은 활성 세대)에서 같은 근거가 어떻게 되었는지. 내용 해시로 판정하므로 다른 색인의 참조도 비교한다. */
  current: {
    indexGeneration: number;
    state: 'same' | 'changed' | 'moved' | 'removed';
    /** moved일 때 무엇으로 찾았는지. content는 같은 내용 해시, key는 같은 프로젝트의 같은 키(내용은 다를 수 있다)다. */
    movedBy: 'content' | 'key' | null;
    itemId: string | null;
    itemSha256: string | null;
    segment: { state: 'same' | 'moved' | 'changed' | 'removed' | 'not-requested'; segmentId: string | null; segmentSha256: string | null };
    candidates: string[];
    knowledge: KnowledgeState | null;
  };
}

export interface VerifyResponse {
  schema: 'agent-knowledge.verify';
  schemaVersion: 1;
  ok: true;
  status: 'ok';
  notice: string;
  indexId: string | null;
  appliedScope: AppliedScope;
  against: { indexGeneration: number; activeGeneration: number | null };
  results: VerifyResult[];
  summary: { total: number; intact: number; problems: number; current: Record<VerifyResult['current']['state'], number> };
}

const SEGMENT_COLUMNS = 's.segment_pk AS pk, s.item_pk AS itemPk, s.ordinal AS ordinal, s.segment_id AS segmentId, s.start_line AS startLine, s.end_line AS endLine, s.content AS content, s.content_sha256 AS sha256, s.token_count AS tokenCount';

function knowledgeOf(item: ScopedItem): KnowledgeState {
  return { status: item.effectiveStatus, confirmed: CONFIRMED.has(item.effectiveStatus) };
}

function segmentsOf(db: DatabaseSync, itemPk: number): SegmentRow[] {
  return all<SegmentRow>(db, `SELECT ${SEGMENT_COLUMNS} FROM item_segments s WHERE s.item_pk = ? ORDER BY s.ordinal`, [itemPk]);
}

function scopeAt(scope: EffectiveScope, generation: number): EffectiveScope {
  return { ...scope, generation };
}

function find(db: DatabaseSync, scope: EffectiveScope, sql: string, params: (string | number)[]): ScopedItem[] {
  return selectItems(db, inEffectiveScope(scope), { sql, params });
}

const OPTIONAL_FIELDS = ['sourceId', 'projectId', 'documentSha256', 'blobSha', 'path', 'startLine', 'endLine'] as const;

/** 참조 세대에서 찾은 범위 안 항목도 함께 돌려준다. 현재 세대에서 키로 옮겨 간 곳을 찾을 때 쓴다. */
function referenceCheck(db: DatabaseSync, scope: EffectiveScope, indexId: string | null, ref: Reference, commitOf: (generation: number, sourceId: string) => string | undefined): { check: VerifyResult['reference']; item?: ScopedItem } {
  if (ref.indexId !== indexId) return { check: { verdict: 'other-index', mismatches: [], knowledge: null } };
  const retained = all<{ found: number }>(db, 'SELECT 1 AS found FROM generations WHERE generation = ?', [ref.indexGeneration]).length > 0;
  if (!retained) return { check: { verdict: 'generation-missing', mismatches: [], knowledge: null } };
  // 범위 밖 항목은 없는 것과 같게 보고한다. 구분하면 다른 프로젝트 항목의 존재가 드러난다
  const item = find(db, scopeAt(scope, ref.indexGeneration), 'i.item_id = ?', [ref.itemId])[0];
  if (!item) return { check: { verdict: 'not-found', mismatches: [], knowledge: null } };
  const mismatches: string[] = [];
  if (item.itemSha256 !== ref.itemSha256) mismatches.push('itemSha256');
  const actual: Record<(typeof OPTIONAL_FIELDS)[number], string | number> = { sourceId: item.sourceId, projectId: item.projectId, documentSha256: item.documentSha256, blobSha: item.blobSha, path: item.path, startLine: item.startLine, endLine: item.endLine };
  for (const field of OPTIONAL_FIELDS) if (ref[field] !== undefined && ref[field] !== actual[field]) mismatches.push(field);
  if (ref.commit !== undefined && commitOf(ref.indexGeneration, item.sourceId) !== ref.commit) mismatches.push('commit');
  if (ref.segmentId) {
    const segment = segmentsOf(db, item.pk).find((candidate) => candidate.segmentId === ref.segmentId);
    if (!segment) mismatches.push('segmentId');
    else {
      if (ref.segmentSha256 !== undefined && ref.segmentSha256 !== segment.sha256) mismatches.push('segmentSha256');
      if (ref.segmentStartLine !== undefined && ref.segmentStartLine !== null && ref.segmentStartLine !== segment.startLine) mismatches.push('segmentStartLine');
      if (ref.segmentEndLine !== undefined && ref.segmentEndLine !== null && ref.segmentEndLine !== segment.endLine) mismatches.push('segmentEndLine');
    }
  }
  return { check: { verdict: mismatches.length === 0 ? 'intact' : 'mismatch', mismatches, knowledge: knowledgeOf(item) }, item };
}

/**
 * 같은 ID에 같은 해시면 same, 같은 ID에 다른 해시면 changed다. 같은 ID가 없으면 범위 안 다른 항목에서 같은 해시를 찾고,
 * 없으면 참조 세대의 항목 키와 같은 키를 같은 프로젝트에서 찾아 moved로 알린다. 둘 다 없으면 removed다.
 * 키는 참조 세대가 보존되어 있고 그 항목이 범위 안일 때만 안다.
 */
function currentCheck(db: DatabaseSync, scope: EffectiveScope, ref: Reference, original: ScopedItem | undefined): VerifyResult['current'] {
  const sameId = find(db, scope, 'i.item_id = ?', [ref.itemId])[0];
  const segmentOf = (item: ScopedItem | undefined): VerifyResult['current']['segment'] => {
    if (!ref.segmentId) return { state: 'not-requested', segmentId: null, segmentSha256: null };
    if (!item) return { state: 'removed', segmentId: null, segmentSha256: null };
    const segments = segmentsOf(db, item.pk);
    const byHash = ref.segmentSha256 ? segments.find((segment) => segment.sha256 === ref.segmentSha256) : undefined;
    if (byHash) return { state: byHash.segmentId === ref.segmentId ? 'same' : 'moved', segmentId: byHash.segmentId, segmentSha256: byHash.sha256 };
    const byId = segments.find((segment) => segment.segmentId === ref.segmentId);
    return byId ? { state: 'changed', segmentId: byId.segmentId, segmentSha256: byId.sha256 } : { state: 'removed', segmentId: null, segmentSha256: null };
  };
  if (sameId) {
    const state = sameId.itemSha256 === ref.itemSha256 ? 'same' : 'changed';
    return { indexGeneration: scope.generation, state, movedBy: null, itemId: sameId.id, itemSha256: sameId.itemSha256, segment: segmentOf(sameId), candidates: [], knowledge: knowledgeOf(sameId) };
  }
  const movedTo = (ids: string[], movedBy: 'content' | 'key'): VerifyResult['current'] => {
    const sorted = [...new Set(ids)].sort(compareStrings);
    const first = find(db, scope, 'i.item_id = ?', [sorted[0]!])[0]!;
    return { indexGeneration: scope.generation, state: 'moved', movedBy, itemId: first.id, itemSha256: first.itemSha256, segment: segmentOf(first), candidates: sorted.slice(0, MAX_CANDIDATES), knowledge: knowledgeOf(first) };
  };
  const sourceClause = ref.sourceId === undefined ? '' : ' AND d.source_id = ?';
  const byContent = find(db, scope, `i.content_sha256 = ?${sourceClause}`, [ref.itemSha256, ...(ref.sourceId === undefined ? [] : [ref.sourceId])]).map((item) => item.id);
  if (byContent.length > 0) return movedTo(byContent, 'content');
  if (original?.key) {
    const byKey = find(db, scope, 'i.key = ? AND d.project_id = ?', [original.key, original.projectId]).map((item) => item.id);
    if (byKey.length > 0) return movedTo(byKey, 'key');
  }
  return { indexGeneration: scope.generation, state: 'removed', movedBy: null, itemId: null, itemSha256: null, segment: segmentOf(undefined), candidates: [], knowledge: null };
}

/** 소비자가 넘겨받은 참조를 다시 확인한다. 결과는 참조 무결성과 현재 상태이며, 승인·검증·완료를 뜻하지 않는다. */
export function verifyReferences(context: RetrievalContext, raw: unknown): VerifyResponse {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new KnowledgeError('invalid-request', '확인 요청의 형식이 올바르지 않습니다', { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
  const { profile: profileName, references, against } = parsed.data;
  const profile = context.retrieval.profiles[profileName];
  const requested = parseScope(parsed.data.scope, profile);
  const version = against?.generation === undefined ? {} : { generation: against.generation };

  return withGeneration(
    context,
    requested,
    version,
    (db, selected) => {
      const scope: EffectiveScope = { ...requested, generation: selected.generation, kinds: null, statuses: [...EFFECTIVE_STATUSES], statusesExplicit: false };
      const commitOf = (generation: number, sourceId: string): string | undefined =>
        all<{ commit: string }>(db, 'SELECT commit_sha AS "commit" FROM generation_sources WHERE generation = ? AND source_id = ?', [generation, sourceId])[0]?.commit;
      const results = references.map((ref, index): VerifyResult => {
        const { check, item } = referenceCheck(db, scope, selected.indexId, ref, commitOf);
        return { position: index, handle: ref.handle ?? null, itemId: ref.itemId, reference: check, current: currentCheck(db, scope, ref, item) };
      });
      const tally = { same: 0, changed: 0, moved: 0, removed: 0 };
      for (const result of results) tally[result.current.state]++;
      const intact = results.filter((result) => result.reference.verdict === 'intact').length;
      return {
        schema: 'agent-knowledge.verify',
        schemaVersion: 1,
        ok: true,
        status: 'ok',
        notice: NOTICE,
        indexId: selected.indexId,
        appliedScope: appliedScopeOf(scope),
        against: { indexGeneration: selected.generation, activeGeneration: selected.activeGeneration },
        results,
        summary: { total: results.length, intact, problems: results.length - intact, current: tally },
      };
    },
    { requireCurrentSchema: true },
  );
}
