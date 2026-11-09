import { z } from 'zod';
import { KnowledgeError } from '../errors.js';
import { EFFECTIVE_STATUSES } from '../model.js';
import { appliedScopeOf, indexInfoOf, NOTICE, renderItem } from './compose.js';
import { inEffectiveScope, parseScope, selectItemIds, selectItems, versionSchema, withGeneration, type EffectiveScope } from './scope.js';
import type { GetResponse, RetrievalContext } from './types.js';

const requestSchema = z.strictObject({
  id: z.string().min(1),
  profile: z.enum(['master', 'code']),
  scope: z.unknown(),
  version: versionSchema.optional(),
});

export function getItem(context: RetrievalContext, raw: unknown): GetResponse {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new KnowledgeError('invalid-request', '조회 요청의 형식이 올바르지 않습니다', { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
  const { id, profile: profileName, version } = parsed.data;
  const profile = context.retrieval.profiles[profileName];
  const requested = parseScope(parsed.data.scope, profile);

  return withGeneration(context, requested, version ?? {}, (db, selected) => {
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
      limitations: [{ code: 'worktree-not-indexed', message: '선택한 커밋의 추적 문서만 색인합니다. 커밋되지 않은 변경은 반영되지 않습니다', detail: {} }],
    };
  });
}
