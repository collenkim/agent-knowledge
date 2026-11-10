import { z } from 'zod';
import { KnowledgeError } from '../errors.js';
import { EFFECTIVE_STATUSES } from '../model.js';
import { appliedScopeOf, indexInfoOf, NOTICE, renderItem, type RenderContext } from './compose.js';
import { indexInfoV2Of, renderItemV2 } from './compose-v2.js';
import { all, inEffectiveScope, ITEM_SOURCE, parseScope, selectItemIds, selectItems, versionSchema, versionSchemaV2, withGeneration, type EffectiveScope } from './scope.js';
import type { GetRequest, GetRequestV2, GetResponse, GetResponseV2, RetrievalContext } from './types.js';
import { segmentCounts, type SegmentRow } from './units.js';

const requestSchema = z.strictObject({
  responseVersion: z.literal(1).optional(),
  id: z.string().min(1),
  profile: z.enum(['master', 'code']),
  scope: z.unknown(),
  version: versionSchema.optional(),
});

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const requestSchemaV2 = z.strictObject({
  responseVersion: z.literal(2),
  id: z.string().min(1),
  profile: z.enum(['master', 'code']),
  scope: z.unknown(),
  version: versionSchemaV2.optional(),
  expect: z.strictObject({ itemSha256: SHA256.optional(), segmentSha256: SHA256.optional() }).optional(),
});

const WORKTREE_NOTICE = { code: 'worktree-not-indexed', message: '선택한 커밋의 추적 문서만 색인합니다. 커밋되지 않은 변경은 반영되지 않습니다', detail: {} };
const SEGMENT_COLUMNS = 's.segment_pk AS pk, s.item_pk AS itemPk, s.ordinal AS ordinal, s.segment_id AS segmentId, s.start_line AS startLine, s.end_line AS endLine, s.content AS content, s.content_sha256 AS sha256, s.token_count AS tokenCount';

function invalid(error: z.ZodError): KnowledgeError {
  return new KnowledgeError('invalid-request', '조회 요청의 형식이 올바르지 않습니다', { issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
}

function versionOf(raw: unknown): 1 | 2 {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).responseVersion : undefined;
  if (value === undefined || value === 1) return 1;
  if (value === 2) return 2;
  throw new KnowledgeError('invalid-request', '지원하지 않는 응답 형식입니다', { reason: 'unsupported-response-version', requested: value, supported: [1, 2] });
}

/** 기존 형식(v1) 라이브러리 진입점. 형식 2는 getItemV2로 보낸다. */
export function getItem(context: RetrievalContext, raw: GetRequest | unknown): GetResponse {
  if (versionOf(raw) === 2) throw new KnowledgeError('invalid-request', 'responseVersion 2 요청은 getItemV2로 보내 주십시오', { reason: 'use-get-v2' });
  return getAny(context, raw) as GetResponse;
}

export function getItemV2(context: RetrievalContext, raw: GetRequestV2 | unknown): GetResponseV2 {
  if (versionOf(raw) !== 2) throw new KnowledgeError('invalid-request', 'getItemV2에는 responseVersion 2 요청만 보낼 수 있습니다', { reason: 'response-version-2-required', fields: ['responseVersion'] });
  return getAny(context, raw) as GetResponseV2;
}

export function getAny(context: RetrievalContext, raw: unknown): GetResponse | GetResponseV2 {
  if (versionOf(raw) === 2) return getV2(context, raw);
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  // search와 같은 이유로 조용히 버리지 않는다. 형식 2로 바꾸면 된다는 것을 호출자가 알 수 있어야 한다
  const version = record.version;
  const v2Fields = [
    ...(Object.hasOwn(record, 'expect') ? ['expect'] : []),
    ...(typeof version === 'object' && version !== null ? ['indexId', 'exact'].filter((field) => Object.hasOwn(version, field)).map((field) => `version.${field}`) : []),
  ];
  if (v2Fields.length > 0) throw new KnowledgeError('invalid-request', '이 필드는 responseVersion 2 요청에서만 쓸 수 있습니다', { reason: 'response-version-2-required', fields: v2Fields });
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const { id, profile: profileName } = parsed.data;
  const profile = context.retrieval.profiles[profileName];
  const requested = parseScope(parsed.data.scope, profile);

  return withGeneration(context, requested, parsed.data.version ?? {}, (db, selected) => {
    const scope: EffectiveScope = { ...requested, generation: selected.generation, kinds: null, statuses: [...EFFECTIVE_STATUSES], statusesExplicit: false };
    const predicate = inEffectiveScope(scope);
    const item = selectItems(db, predicate, { sql: 'i.item_id = ?', params: [id] })[0];
    // 범위 밖과 부재를 구분하면 다른 프로젝트 항목의 존재 여부가 드러난다
    if (!item) throw new KnowledgeError('not-found', '항목을 찾을 수 없습니다', { id });

    const section = profile.sections.find((candidate) => candidate.kinds.includes(item.kind))!.id;
    const rendered = renderItem({ item, section, score: 0, reasons: ['id-lookup'], terms: [] }, 1, {
      selected,
      inScope: selectItemIds(db, predicate),
      included: new Set([item.id]),
      excerptChars: profile.excerptChars,
      evaluated: () => ({ phase: false, paths: false }),
    });
    return {
      schema: 'agent-knowledge.get',
      schemaVersion: 1,
      ok: true,
      status: 'ok',
      notice: NOTICE,
      appliedScope: appliedScopeOf(scope),
      index: indexInfoOf(selected, scope),
      item: { ...rendered, content: item.content },
      limitations: [WORKTREE_NOTICE],
    };
  });
}

/** 항목 ID나 조각 ID(`<항목 ID>#<순번>`)를 받는다. 조각은 선택한 세대의 범위 안 항목에서만 찾는다. */
function getV2(context: RetrievalContext, raw: unknown): GetResponseV2 {
  const parsed = requestSchemaV2.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const { id, profile: profileName, version, expect } = parsed.data;
  const profile = context.retrieval.profiles[profileName];
  const requested = parseScope(parsed.data.scope, profile);

  return withGeneration(
    context,
    requested,
    version ?? {},
    (db, selected) => {
      const scope: EffectiveScope = { ...requested, generation: selected.generation, kinds: null, statuses: [...EFFECTIVE_STATUSES], statusesExplicit: false };
      const predicate = inEffectiveScope(scope);
      const direct = selectItems(db, predicate, { sql: 'i.item_id = ?', params: [id] })[0];
      const segment = all<SegmentRow>(db, `SELECT ${SEGMENT_COLUMNS} FROM item_segments s WHERE s.segment_id = ? AND s.item_pk IN (SELECT i.item_pk FROM ${ITEM_SOURCE} WHERE ${predicate.sql})`, [id, ...predicate.params])[0];
      if (direct && segment) throw new KnowledgeError('invalid-request', '항목 ID와 조각 ID가 모두 일치합니다', { reason: 'ambiguous-id', id });
      const item = direct ?? (segment ? selectItems(db, predicate, { sql: 'i.item_pk = ?', params: [segment.itemPk] })[0] : undefined);
      if (!item) throw new KnowledgeError('not-found', '항목을 찾을 수 없습니다', { id });
      // 기대 해시가 다르면 같은 ID의 다른 내용을 조용히 돌려주지 않는다
      const mismatches = [
        ...(expect?.itemSha256 !== undefined && expect.itemSha256 !== item.itemSha256 ? ['itemSha256'] : []),
        ...(expect?.segmentSha256 !== undefined && expect.segmentSha256 !== (segment?.sha256 ?? null) ? ['segmentSha256'] : []),
      ];
      if (mismatches.length > 0) throw new KnowledgeError('invalid-request', '기대한 해시와 색인된 내용이 다릅니다', { reason: 'hash-mismatch', id, fields: mismatches });

      const section = profile.sections.find((candidate) => candidate.kinds.includes(item.kind))!.id;
      const ctx: RenderContext = { selected, inScope: selectItemIds(db, predicate), included: new Set([item.id]), excerptChars: profile.excerptChars, evaluated: () => ({ phase: false, paths: false }) };
      const counts = segmentCounts(db, segment ? [segment.itemPk] : []);
      const rendered = renderItemV2({ item, section, score: 0, reasons: ['id-lookup'], terms: [], group: 'lookup', segment: segment ?? null, queries: [], directRank: null }, 1, ctx, counts);
      return {
        schema: 'agent-knowledge.get',
        schemaVersion: 2,
        ok: true,
        status: 'ok',
        notice: NOTICE,
        appliedScope: appliedScopeOf(scope),
        index: indexInfoV2Of(selected, scope, version ?? {}),
        item: { ...rendered, content: item.content, segmentContent: segment?.content ?? null },
        limitations: [WORKTREE_NOTICE],
      };
    },
    { requireCurrentSchema: true },
  );
}
