import type { DatabaseSync } from 'node:sqlite';
import { SEGMENT_MAX_CHARS } from '../parsing/segments.js';
import { configHashOf, type RetrievalConfig } from '../profiles/config.js';
import { compareStrings } from '../util/compare.js';
import { canonicalJson, sha256 } from '../util/hash.js';
import { PACKAGE_VERSION } from '../util/package-info.js';
import {
  appliedScopeOf,
  codeLocationsOf,
  DEPENDENCY_SECTION,
  excerptOf,
  indexInfoOf,
  inRequestedProject,
  limitationsOf,
  MANDATORY_SECTION,
  unindexedSourcesOf,
  NOTICE,
  renderItem,
  type ComposeInput,
  type PickedItem,
  type RenderContext,
} from './compose.js';
import type { EffectiveScope, ScopedItem, SelectedGeneration, VersionSelector } from './scope.js';
import { RESULT_GROUPS, type BudgetReport, type CompositionCounts, type IndexInfoV2, type ItemRef, type Limitation, type OutputItemV2, type OutputSegment, type ResultGroup, type SearchCounts, type SearchResponseV2 } from './types.js';
import { segmentCounts, type SegmentRow } from './units.js';

/** 예산으로 빠진 항목을 이 수까지만 나열하고 나머지는 omittedCount로만 알린다. 목록이 예산을 다시 넘기지 않게 한다. */
const MAX_OMITTED_LISTED = 50;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

/** 인용용 짧은 이름. 조회 키가 아니라 소비자가 전체 참조를 가리킬 때 쓴다. */
export function refHandle(ref: Pick<ItemRef, 'indexId' | 'indexGeneration' | 'itemId' | 'segmentId' | 'itemSha256' | 'segmentSha256'>): string {
  const { indexId, indexGeneration, itemId, segmentId, itemSha256, segmentSha256 } = ref;
  return `ak-${sha256(canonicalJson({ indexId, indexGeneration, itemId, segmentId, itemSha256, segmentSha256 })).slice(0, 20)}`;
}

export function refOf(item: ScopedItem, segment: SegmentRow | null, selected: SelectedGeneration): ItemRef {
  const commit = selected.sources.find((source) => source.sourceId === item.sourceId)!.commit;
  const body: Omit<ItemRef, 'handle'> = {
    indexId: selected.indexId,
    indexGeneration: selected.generation,
    sourceId: item.sourceId,
    projectId: item.projectId,
    commit,
    itemId: item.id,
    itemSha256: item.itemSha256,
    documentSha256: item.documentSha256,
    blobSha: item.blobSha,
    path: item.path,
    startLine: item.startLine,
    endLine: item.endLine,
    segmentId: segment?.segmentId ?? null,
    segmentSha256: segment?.sha256 ?? null,
    segmentStartLine: segment?.startLine ?? null,
    segmentEndLine: segment?.endLine ?? null,
  };
  return { handle: refHandle(body), ...body };
}

function headingOf(content: string): string | null {
  const first = content.slice(0, content.indexOf('\n') < 0 ? content.length : content.indexOf('\n'));
  const match = ATX_HEADING.exec(first);
  return match ? (match[1] ?? '').trim() || null : null;
}

export function outputSegmentOf(segment: SegmentRow, count: number): OutputSegment {
  return { id: segment.segmentId, ordinal: segment.ordinal, count, startLine: segment.startLine, endLine: segment.endLine, sha256: segment.sha256, heading: headingOf(segment.content) };
}

/** 범위 밖 원본은 넣지 않는다. 전체 세대 지문은 범위 밖 프로젝트의 변경을 드러내므로 운영 명령(status·index)에만 싣는다. */
export function scopeFingerprintOf(selected: SelectedGeneration, scope: EffectiveScope): string {
  const sources = selected.sources.filter((source) => inRequestedProject(scope, source.projectId)).map(({ sourceId, projectId, commit, configSha256 }) => ({ sourceId, projectId, commit, configSha256 }));
  const { parserVersion, chunkerVersion, tokenizerVersion, resolverVersion } = selected;
  return sha256(canonicalJson({ sources, links: scope.links, versions: { parserVersion, chunkerVersion, tokenizerVersion, resolverVersion } }));
}

export function indexInfoV2Of(selected: SelectedGeneration, scope: EffectiveScope, version: VersionSelector): IndexInfoV2 {
  const base = indexInfoOf(selected, scope);
  const by = version.generation !== undefined ? (version.commits ? 'generation+commits' : 'generation') : version.commits ? 'commits' : 'active';
  return {
    ...base,
    sources: base.sources.map((source) => ({ ...source, refOrigin: selected.sources.find((candidate) => candidate.sourceId === source.sourceId)!.refOrigin })),
    indexId: selected.indexId,
    scopeFingerprint: scopeFingerprintOf(selected, scope),
    activated: selected.activated,
    activeGeneration: selected.activeGeneration,
    selection: { by, exact: version.exact === true },
  };
}

export function renderItemV2(pick: PickedItem, rank: number, ctx: RenderContext, counts: ReadonlyMap<number, number>): OutputItemV2 {
  const segment = pick.segment ?? null;
  const base = renderItem(pick, rank, ctx, segment ? { content: segment.content, startLine: segment.startLine } : undefined);
  return {
    ...base,
    knowledge: { ...base.knowledge, declaration: pick.item.declaration },
    selection: { ...base.selection, directRank: pick.directRank ?? null, matchedQueries: pick.queries ?? [] },
    group: pick.group!,
    mandatory: pick.item.designatedMandatory,
    segment: segment ? outputSegmentOf(segment, counts.get(segment.itemPk) ?? 1) : null,
    operations: pick.item.operations,
    ref: refOf(pick.item, segment, ctx.selected),
  };
}

export interface ComposeV2Options {
  echo: {
    queries: SearchResponseV2['request']['queries'];
    ranker: 'legacy' | 'bm25';
    segments: boolean;
    include: SearchResponseV2['request']['include'];
    quota: SearchResponseV2['request']['quota'];
    budget: SearchResponseV2['request']['budget'];
    documents: string[] | null;
    version: VersionSelector;
  };
  ranker: 'legacy' | 'bm25';
  rankerVersion: string;
  queryVersion: string;
  segments: { requested: boolean; effective: boolean };
  budget: SearchResponseV2['request']['budget'];
  /** 질의를 자르거나 합친 사실. 요청 메아리는 자른 뒤의 값이므로 따로 받는다. */
  queryNotes: Limitation[];
  extraLimitations: Limitation[];
  retrieval: RetrievalConfig;
}

interface ComposeV2Input extends ComposeInput {
  db: DatabaseSync;
  directMatched: number;
  /** 질의·경로와 일치했지만 필수·의존 묶음에 이미 있어 직접 결과에서 뺀 항목 수. */
  supplementaryMatched: number;
  options: ComposeV2Options;
}

function countGroups(picks: readonly PickedItem[]): Omit<SearchCounts, 'directMatched' | 'supplementaryMatched'> {
  const count = (group: ResultGroup): number => picks.filter((pick) => pick.group === group).length;
  return { mandatory: count('mandatory'), dependencies: count('dependencies'), direct: count('direct'), linked: count('linked') };
}

function histogram(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => compareStrings(a, b)));
}

function compositionOf(items: readonly OutputItemV2[]): CompositionCounts {
  return { byProject: histogram(items.map((item) => item.projectId)), byKind: histogram(items.map((item) => item.kind)) };
}

function omittedOf(pick: PickedItem): BudgetReport['omitted'][number] {
  return { id: pick.item.id, segmentId: pick.segment?.segmentId ?? null, group: pick.group as ResultGroup, directRank: pick.directRank ?? null };
}

/**
 * 응답 형식 2를 만든다. 예산은 묶음 우선순위대로 줄 세운 뒤 앞에서부터 남기고, 남은 항목만으로 sections·links.included·codeLocations·
 * limitations·directCount를 다시 계산한다. 예산 적용 전 수는 retrieval.counts에 남긴다.
 */
export function composeSearchV2(input: ComposeV2Input): SearchResponseV2 {
  const { db, request, scope, selected, profile, inScope, evaluated, mandatory, dependencies, direct, linked, options, directMatched, supplementaryMatched } = input;
  const groups: Record<ResultGroup, readonly PickedItem[]> = { mandatory, dependencies, direct, linked };
  const priority = options.budget?.priority ?? [...RESULT_GROUPS];
  const ordered = priority.flatMap((group) => groups[group]);
  const counts: SearchCounts = { ...countGroups(ordered), directMatched, supplementaryMatched };
  // 일치한 항목이 필수 묶음에만 들어 있어도 질의는 일치한 것이다. 이때 '일치 없음'으로 알리면 소비자가 결과를 잘못 버린다
  const outcome: SearchResponseV2['retrieval']['outcome'] = direct.length > 0 || supplementaryMatched > 0 ? 'matched' : ordered.length > 0 ? 'supplementary-only' : 'no-results';

  const configHash = configHashOf(options.retrieval, request.profile);
  const versions = {
    ranker: options.rankerVersion,
    query: options.queryVersion,
    parser: selected.parserVersion,
    chunker: selected.chunkerVersion,
    tokenizer: selected.tokenizerVersion,
    resolver: selected.resolverVersion,
    package: PACKAGE_VERSION,
  };
  const index = indexInfoV2Of(selected, scope, options.echo.version);
  const { version: _selector, ...echo } = options.echo;
  const requestEcho: SearchResponseV2['request'] = { ...request, responseVersion: 2, ...echo };
  const appliedScope = { ...appliedScopeOf(scope), documents: scope.documents ?? null };
  const segmentPks = [...new Set(ordered.flatMap((pick) => (pick.segment ? [pick.segment.itemPk] : [])))];
  const segmentTotals = segmentCounts(db, segmentPks);
  // 세대를 고른 방식(활성·번호·커밋)이 아니라 실제로 고른 세대를 넣어야 같은 결과를 다시 요청해도 같은 값이 나온다.
  // 질의를 자른 사실과 설정에만 있는 원본은 결과의 limitations를 바꾸므로 함께 넣는다. 문서 필터는 원문 대신 정규화한 appliedScope.documents만 쓴다
  const { documents: _rawDocuments, ...hashedEcho } = requestEcho;
  const requestDigest = sha256(
    canonicalJson({
      responseVersion: 2,
      request: hashedEcho,
      appliedScope,
      queryPlan: options.queryNotes,
      unindexedSources: unindexedSourcesOf(input.context, scope, selected),
      indexId: selected.indexId,
      indexGeneration: selected.generation,
      scopeFingerprint: index.scopeFingerprint,
      configHash,
      versions,
    }),
  );
  const limits: BudgetReport['limits'] = {
    maxItems: options.budget?.maxItems ?? null,
    maxExcerptChars: options.budget?.maxExcerptChars ?? null,
    maxResponseBytes: options.budget?.maxResponseBytes ?? null,
    priority,
  };

  const build = (keep: number, exceeded: boolean): SearchResponseV2 => {
    const keptSet = new Set(ordered.slice(0, keep));
    const kept = RESULT_GROUPS.flatMap((group) => groups[group].filter((pick) => keptSet.has(pick)));
    const ctx: RenderContext = { selected, inScope, included: new Set(kept.map((pick) => pick.item.id)), excerptChars: profile.excerptChars, evaluated };
    const items = kept.map((pick, index) => renderItemV2(pick, index + 1, ctx, segmentTotals));
    const sections = [MANDATORY_SECTION, DEPENDENCY_SECTION, ...profile.sections].map(({ id, title }) => ({ id, title, itemIds: items.filter((item) => item.selection.section === id).map((item) => item.id) }));
    const keptCounts = countGroups(kept);
    const dropped = ordered.slice(keep);

    const limitations = limitationsOf(input, items, keptCounts.direct).filter((limitation) => !(limitation.code === 'no-query-matches' && outcome === 'matched'));
    limitations.push(...options.extraLimitations);
    if (dropped.length > 0) {
      limitations.push({ code: 'budget-truncated', message: '출력 예산을 넘어 일부 항목을 뺐습니다. budget.omitted의 ID로 get을 호출할 수 있습니다', detail: { count: dropped.length, byGroup: countGroups(dropped) } });
    }
    if (direct.length > 0 && keptCounts.direct === 0) limitations.push({ code: 'direct-crowded-out', message: '질의와 일치한 자료가 있으나 예산 때문에 하나도 남지 않았습니다', detail: { directMatched } });
    if (exceeded) limitations.push({ code: 'budget-exceeded', message: '항목 없이도 응답이 maxResponseBytes를 넘습니다', detail: { maxResponseBytes: limits.maxResponseBytes } });
    limitations.sort((a, b) => compareStrings(a.code, b.code));

    const codeLocations = profile.includeCodeLocations ? codeLocationsOf(kept, selected) : [];
    const budget: BudgetReport = { limits, truncated: dropped.length > 0, exceeded, omitted: dropped.slice(0, MAX_OMITTED_LISTED).map(omittedOf), omittedCount: dropped.length };
    const itemsDigest = sha256(canonicalJson({ items: items.map((item) => ({ ref: item.ref, group: item.group, rank: item.selection.rank })), omitted: dropped.map(omittedOf) }));
    const resultDigest = sha256(canonicalJson({ items, sections, codeLocations, limitations, configHash, versions }));
    return {
      schema: 'agent-knowledge.search',
      schemaVersion: 2,
      ok: true,
      status: outcome === 'no-results' ? 'no-results' : 'ok',
      notice: NOTICE,
      request: requestEcho,
      appliedScope,
      index,
      retrieval: {
        mode: 'keyword',
        vector: { enabled: false, state: 'not-implemented' },
        directCount: keptCounts.direct,
        outcome,
        ranker: { name: options.ranker, version: options.rankerVersion },
        queryVersion: options.queryVersion,
        segments: { ...options.segments, chunkerVersion: selected.chunkerVersion, maxChars: SEGMENT_MAX_CHARS },
        configHash,
        counts: { ...counts, kept: keptCounts },
        composition: { direct: compositionOf(items.filter((item) => item.group === 'direct')), supplementary: compositionOf(items.filter((item) => item.group !== 'direct')) },
      },
      sections,
      items,
      codeLocations,
      limitations,
      budget,
      digests: { request: requestDigest, items: itemsDigest, result: resultDigest },
    };
  };

  let keep = ordered.length;
  if (limits.maxItems !== null) keep = Math.min(keep, limits.maxItems);
  if (limits.maxExcerptChars !== null) {
    let used = 0;
    let fit = 0;
    for (; fit < keep; fit++) {
      const pick = ordered[fit]!;
      const source = pick.segment ? pick.segment.content : pick.item.content;
      const length = excerptOf(source, pick.terms, profile.excerptChars).text.length;
      if (used + length > limits.maxExcerptChars) break;
      used += length;
    }
    keep = fit;
  }
  let exceeded = false;
  const maxBytes = limits.maxResponseBytes;
  if (maxBytes !== null) {
    // 출력은 --pretty와 상관없이 들여쓰지 않은 JSON의 UTF-8 바이트로 잰다
    const size = (n: number): number => Buffer.byteLength(JSON.stringify(build(n, false)), 'utf8');
    if (size(keep) > maxBytes) {
      let low = 0;
      let high = keep - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (size(middle) <= maxBytes) low = middle;
        else high = middle - 1;
      }
      while (low > 0 && size(low) > maxBytes) low--;
      keep = low;
      exceeded = size(0) > maxBytes;
    }
  }
  return build(keep, exceeded);
}
