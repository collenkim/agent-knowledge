import { RELATIONS, type BaseStatus, type BasisRef, type EffectiveStatus, type Kind, type Relation, type Relations, type SourceRule } from '../model.js';
import { compareStrings } from '../util/compare.js';
import { normalizeRepoPath } from '../util/paths.js';

export interface BasisResult extends BasisRef {
  resolved: boolean;
  targetItemId?: string;
}

export interface BasisRecord {
  kind: 'declared' | 'source-rule' | 'refs' | 'code-reference' | 'none';
  resolution?: 'resolved' | 'operator-declared' | 'unresolved';
  value?: string;
  rule?: string;
  refs?: BasisResult[];
}

export interface StatusInput {
  declared: BaseStatus | null;
  rawDeclared: string | null;
  basis: readonly BasisResult[];
  rule: SourceRule | null;
  codeLinks: readonly { resolved: boolean }[];
}

interface StatusResolution {
  status: BaseStatus;
  reason: string;
  basis: BasisRecord;
}

export interface LinkRecord {
  relation: Relation;
  target: string;
  resolved: boolean;
  kind: 'path' | 'item';
  ambiguous?: boolean;
  candidates?: string[];
  targetItemId?: string;
  targetProject?: string;
  /** 앵커·키 없이 문서 경로만 가리키는 `대체`다. targetItemId는 그 문서의 첫 항목이고, 대체는 문서 전체에 적용한다. */
  wholeDocument?: true;
}

export interface Conflict {
  reason: 'declared' | 'duplicate-key' | 'duplicate-contract-owner' | 'unconfirmed-supersession';
  withItemIds: string[];
  target?: string;
}

export interface GenerationItem {
  itemPk: number;
  itemId: string;
  documentPk: number;
  sourceId: string;
  projectId: string;
  path: string;
  ordinal: number;
  key: string | null;
  anchor: string;
  kind: Kind;
  declaredStatus: BaseStatus | null;
  declaredStatusRaw: string | null;
  basisRefs: BasisRef[];
  rule: SourceRule | null;
  relations: Relations;
}

/** 트랜잭션 안에서는 git을 부를 수 없으므로 원본 저장소의 사실을 미리 구해 넘긴다. */
export interface SourceFacts {
  tracked: ReadonlySet<string>;
  existingCommits: ReadonlySet<string>;
}

export interface ResolvedItem {
  itemPk: number;
  baseStatus: BaseStatus;
  effectiveStatus: EffectiveStatus;
  reason: string;
  basis: BasisRecord;
  conflicts: Conflict[];
  links: LinkRecord[];
}

function ruleBasis(rule: SourceRule): BasisRecord {
  return { kind: 'source-rule', value: rule.basis, rule: rule.match, resolution: 'operator-declared' };
}

function isConfirmed(status: BaseStatus): boolean {
  return status === 'confirmed_policy' || status === 'verified_experience';
}

export function resolveBaseStatus({ declared, rawDeclared, basis, rule, codeLinks }: StatusInput): StatusResolution {
  if (declared === 'deprecated') return { status: 'deprecated', reason: 'declared-deprecated', basis: { kind: 'declared' } };

  const ruleStatus = rule?.status ?? null;
  // 작성자가 낮게 표시한 항목을 운영자 규칙이 올려 주지 못하게 한다
  const ruleIgnored = ruleStatus !== null && (declared === 'unverified' || declared === 'observed_behavior');
  const target = ruleIgnored ? declared : (ruleStatus ?? declared);
  const refs = [...basis];
  const basisResolved = refs.some((ref) => ref.resolved);
  const unresolved: BasisRecord = { kind: 'none', resolution: 'unresolved', refs };
  const resolved: BasisRecord = { kind: 'refs', resolution: 'resolved', refs };

  // 어휘 밖의 값은 작성자가 무엇을 뜻했는지 알 수 없으므로 규칙은 낮추는 쪽으로만 적용한다
  const raisedOverUnknown = rawDeclared !== null && declared === null && target !== 'unverified' && target !== 'deprecated';
  if (target === null || raisedOverUnknown) return { status: 'unverified', reason: rawDeclared !== null ? 'unknown-status-value' : 'status-not-declared', basis: unresolved };

  if (target === 'unverified') {
    if (ruleIgnored) return { status: 'unverified', reason: 'declared-overrides-source-rule', basis: { kind: 'declared' } };
    return ruleStatus !== null ? { status: 'unverified', reason: 'source-rule', basis: ruleBasis(rule!) } : { status: 'unverified', reason: 'declared', basis: { kind: 'declared' } };
  }

  if (target === 'deprecated') return { status: 'deprecated', reason: 'source-rule', basis: ruleBasis(rule!) };

  if (target === 'observed_behavior') {
    const codeResolved = codeLinks.some((link) => link.resolved);
    if (!codeResolved && !basisResolved) return { status: 'unverified', reason: 'observation-without-code-reference', basis: unresolved };
    const reason = ruleIgnored ? 'declared-overrides-source-rule' : codeResolved ? 'code-reference-resolved' : 'basis-resolved';
    return { status: 'observed_behavior', reason, basis: codeResolved ? { kind: 'code-reference', resolution: 'resolved', refs } : resolved };
  }

  if (basisResolved) return { status: target, reason: 'basis-resolved', basis: resolved };
  if (ruleStatus === target && rule?.basis?.trim()) return { status: target, reason: 'source-rule', basis: ruleBasis(rule) };
  return { status: 'unverified', reason: refs.length > 0 ? 'status-basis-unresolved' : 'status-basis-missing', basis: unresolved };
}

type Reference = { target: GenerationItem; wholeDocument?: boolean } | { candidates: string[] } | null;

function groupBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function createReferenceResolver(items: readonly GenerationItem[]): (target: string, from: GenerationItem) => Reference {
  const byId = new Map(items.map((item) => [item.itemId, item]));
  const projects = new Set(items.map((item) => item.projectId));
  const firstOfDocument = new Map<number, GenerationItem>();
  for (const item of items) {
    const first = firstOfDocument.get(item.documentPk);
    if (!first || item.ordinal < first.ordinal) firstOfDocument.set(item.documentPk, item);
  }
  const byKey = groupBy(items.filter((item) => item.key !== null), (item) => `${item.projectId}\0${item.key}`);
  const byAnchor = groupBy(items, (item) => `${item.projectId}\0${item.path}#${item.anchor}`);
  const byPath = groupBy([...firstOfDocument.values()], (item) => `${item.projectId}\0${item.path}`);

  return (target, from) => {
    const exact = byId.get(target);
    if (exact) return { target: exact };

    const colon = target.indexOf(':');
    const qualified = colon >= 0 && projects.has(target.slice(0, colon));
    const project = qualified ? target.slice(0, colon) : from.projectId;
    const rest = qualified ? target.slice(colon + 1) : target;
    const path = normalizeRepoPath(rest) ?? rest;

    const documentMatch = byPath.get(`${project}\0${path}`);
    for (const matches of [byKey.get(`${project}\0${rest}`), byAnchor.get(`${project}\0${path}`), documentMatch]) {
      if (!matches) continue;
      if (matches.length === 1) return { target: matches[0]!, wholeDocument: matches === documentMatch };
      return { candidates: matches.map((item) => item.itemId).sort(compareStrings) };
    }
    return null;
  };
}

function linksOf(item: GenerationItem, facts: SourceFacts, resolveReference: (target: string, from: GenerationItem) => Reference): LinkRecord[] {
  const links: LinkRecord[] = [];
  for (const relation of [...RELATIONS].sort(compareStrings)) {
    for (const target of [...(item.relations[relation] ?? [])].sort(compareStrings)) {
      if (relation === 'code' || relation === 'test') {
        links.push({ relation, target, resolved: facts.tracked.has(target), kind: 'path' });
        continue;
      }
      const reference = resolveReference(target, item);
      if (reference === null) links.push({ relation, target, resolved: false, kind: 'item' });
      else if ('target' in reference) links.push({ relation, target, resolved: true, kind: 'item', targetItemId: reference.target.itemId, targetProject: reference.target.projectId, ...(relation === 'supersedes' && reference.wholeDocument ? { wholeDocument: true as const } : {}) });
      else links.push({ relation, target, resolved: false, kind: 'item', ambiguous: true, candidates: reference.candidates });
    }
  }
  return links;
}

/** 서로 되돌아올 수 있는 노드가 같은 번호를 받는다. 긴 사슬에서 스택이 넘치지 않도록 재귀 없이 Tarjan을 돈다. 간선의 끝은 모두 키로 있어야 한다. */
function stronglyConnectedComponents(cites: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const visitOrder = new Map<string, number>();
  const lowest = new Map<string, number>();
  const component = new Map<string, number>();
  const open: string[] = [];
  let components = 0;
  const enter = (node: string): { node: string; next: number } => {
    visitOrder.set(node, visitOrder.size);
    lowest.set(node, visitOrder.get(node)!);
    open.push(node);
    return { node, next: 0 };
  };
  for (const root of cites.keys()) {
    if (visitOrder.has(root)) continue;
    const frames = [enter(root)];
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const target = cites.get(frame.node)![frame.next++];
      if (target !== undefined) {
        if (!visitOrder.has(target)) frames.push(enter(target));
        else if (!component.has(target)) lowest.set(frame.node, Math.min(lowest.get(frame.node)!, visitOrder.get(target)!));
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent) lowest.set(parent.node, Math.min(lowest.get(parent.node)!, lowest.get(frame.node)!));
      if (lowest.get(frame.node) !== visitOrder.get(frame.node)) continue;
      let member: string;
      do {
        member = open.pop()!;
        component.set(member, components);
      } while (member !== frame.node);
      components += 1;
    }
  }
  return component;
}

/** 어휘 밖의 상태 값은 그 항목 자신도 미확인으로 판정되므로 근거로서도 같게 본다. */
function cannotBackBasis(item: GenerationItem): boolean {
  return item.declaredStatus === 'deprecated' || item.declaredStatus === 'unverified' || (item.declaredStatus === null && item.declaredStatusRaw !== null);
}

/** 폐기는 선언과 규칙만으로 정해지고 근거에 좌우되지 않으므로 판정 전에도 알 수 있다. 규칙이 덮지 못하는 작성자 표시도 같은 기준으로 살린다. */
function isRetiredOutright(item: GenerationItem): boolean {
  return resolveBaseStatus({ declared: item.declaredStatus, rawDeclared: item.declaredStatusRaw, basis: [], rule: item.rule, codeLinks: [] }).status === 'deprecated';
}

type PathBasisCheck = (ref: BasisRef, item: GenerationItem) => boolean;

/** 색인된 문서를 가리키는 path 근거만 거른다. 색인되지 않은 파일은 인용 그래프에 없고 상태도 없으므로 그대로 유효하다. 대상 항목을 어떤 기준으로 볼지는 판정 단계가 정한다. */
function createPathBasisCheck(items: readonly GenerationItem[]): (cannotBack: (target: GenerationItem) => boolean) => PathBasisCheck {
  const documentKey = (sourceId: string, path: string): string => `${sourceId}\0${path}`;
  const documents = groupBy(items, (item) => documentKey(item.sourceId, item.path));
  const cites = new Map([...documents.keys()].map((key): [string, Set<string>] => [key, new Set()]));
  for (const item of items) {
    // 폐기된 항목의 인용은 무엇도 뒷받침하지 않으므로 순환을 만들지 않는다
    if (isRetiredOutright(item)) continue;
    for (const ref of item.basisRefs) {
      const target = documentKey(item.sourceId, ref.value);
      if (ref.kind === 'path' && documents.has(target)) cites.get(documentKey(item.sourceId, item.path))!.add(target);
    }
  }
  const components = stronglyConnectedComponents(new Map([...cites].map(([key, targets]) => [key, [...targets]])));

  return (cannotBack) => (ref, item) => {
    const target = documentKey(item.sourceId, ref.value);
    const targetItems = documents.get(target);
    if (!targetItems) return true;
    if (components.get(documentKey(item.sourceId, item.path)) === components.get(target)) return false;
    // 없는 앵커는 대상 항목을 알 수 없으므로 문서 전체로 판단한다
    const anchored = ref.anchor === undefined ? undefined : targetItems.find((candidate) => candidate.anchor === ref.anchor);
    return anchored ? !cannotBack(anchored) : !targetItems.every(cannotBack);
  };
}

function directBasis(item: GenerationItem, facts: SourceFacts, pathCanBack: PathBasisCheck): BasisResult[] {
  return item.basisRefs.map((ref) => {
    if (ref.kind === 'path') return { ...ref, resolved: facts.tracked.has(ref.value) && ref.value !== item.path && pathCanBack(ref, item) };
    if (ref.kind === 'commit') return { ...ref, resolved: facts.existingCommits.has(ref.value) };
    return { ...ref, resolved: false };
  });
}

interface ItemState {
  item: GenerationItem;
  resolution: StatusResolution;
  links: LinkRecord[];
  conflicts: Conflict[];
}

/** [대체자, 대상] */
type Supersession = [ItemState, ItemState];

function compareConflicts(a: Conflict, b: Conflict): number {
  return compareStrings(a.reason, b.reason) || compareStrings(a.target ?? '', b.target ?? '') || compareStrings(a.withItemIds.join('\0'), b.withItemIds.join('\0'));
}

function pairKey(a: ItemState, b: ItemState): string {
  return `${a.item.itemId}\0${b.item.itemId}`;
}

/** 같은 프로젝트의 한쪽 방향 대체만 인정한다. 고리를 이루는(서로 또는 자기 자신을 포함한) 대체 선언은 어느 쪽이 새것인지 알려 주지 않는다. */
function supersessionsOf(states: readonly ItemState[]): Supersession[] {
  const byId = new Map(states.map((state) => [state.item.itemId, state]));
  const byDocument = groupBy(states, (state) => String(state.item.documentPk));
  const declarations: { superseder: ItemState; targets: ItemState[] }[] = [];
  const successors = new Map(states.map((state): [string, string[]] => [state.item.itemId, []]));
  for (const state of states) {
    for (const link of state.links) {
      if (link.relation !== 'supersedes' || !link.resolved) continue;
      const first = byId.get(link.targetItemId!)!;
      if (first.item.projectId !== state.item.projectId) continue;
      const targets = link.wholeDocument ? byDocument.get(String(first.item.documentPk))!.filter((target) => target.item.documentPk !== state.item.documentPk) : [first];
      declarations.push({ superseder: state, targets });
      successors.get(state.item.itemId)!.push(...targets.map((target) => target.item.itemId));
    }
  }
  const components = stronglyConnectedComponents(successors);
  const pairs = new Map<string, Supersession>();
  for (const { superseder, targets } of declarations) {
    // 문서 전체 대체의 일부가 고리에 들면 두 문서 중 어느 쪽이 새것인지 모르므로 그 선언을 통째로 뺀다
    if (targets.some((target) => components.get(superseder.item.itemId) === components.get(target.item.itemId))) continue;
    for (const target of targets) pairs.set(pairKey(superseder, target), [superseder, target]);
  }
  return [...pairs.values()];
}

/** 대체자의 상태는 이 처리 전의 값을 보므로 대체 사슬의 결과가 처리 순서에 좌우되지 않는다. */
function applySupersessions(states: readonly ItemState[], supersessions: readonly Supersession[]): ItemState[] {
  const targetOf = ([, target]: Supersession): string => target.item.itemId;
  const retiring = groupBy(supersessions.filter(([superseder]) => isConfirmed(superseder.resolution.status)), targetOf);
  const disputing = groupBy(
    supersessions.filter(([superseder, target]) => !isConfirmed(superseder.resolution.status) && superseder.resolution.status !== 'deprecated' && isConfirmed(target.resolution.status)),
    targetOf,
  );
  return states.map((state) => {
    const retiredBy = retiring.get(state.item.itemId)?.map(([superseder]) => superseder.item.itemId).sort(compareStrings);
    if (retiredBy) {
      const refs = retiredBy.map((id): BasisResult => ({ kind: 'item', value: id, resolved: true, targetItemId: id }));
      return { ...state, conflicts: [], resolution: { status: 'deprecated', reason: 'superseded', basis: { kind: 'refs', resolution: 'resolved', refs } } };
    }
    const conflicts = (disputing.get(state.item.itemId) ?? []).map(([superseder]): Conflict => ({ reason: 'unconfirmed-supersession', withItemIds: [superseder.item.itemId] }));
    return { ...state, conflicts };
  });
}

function detectConflicts(states: readonly ItemState[], supersessions: readonly Supersession[]): void {
  const live = states.filter((state) => state.resolution.status !== 'deprecated');
  const byId = new Map(states.map((state) => [state.item.itemId, state]));

  const declared = new Map<string, [ItemState, ItemState]>();
  const superseding = new Set(supersessions.flatMap(([superseder, target]) => [pairKey(superseder, target), pairKey(target, superseder)]));
  for (const state of live) {
    for (const link of state.links) {
      if (link.relation !== 'conflicts_with') continue;
      if (!link.resolved) {
        state.conflicts.push({ reason: 'declared', withItemIds: [], target: link.target });
        continue;
      }
      const other = byId.get(link.targetItemId!)!;
      // 조상 절의 충돌을 물려받으면 대상이 자기 자신일 수 있다
      if (other === state || other.resolution.status === 'deprecated') continue;
      state.conflicts.push({ reason: 'declared', withItemIds: [other.item.itemId], target: link.target });
      declared.set(pairKey(state, other), [state, other]);
    }
  }
  for (const [declarer, other] of declared.values()) {
    // 양쪽이 서로 선언했으면 이미 각자의 충돌 객체가 있다
    if (!declared.has(pairKey(other, declarer))) other.conflicts.push({ reason: 'declared', withItemIds: [declarer.item.itemId] });
  }

  const flagDuplicates = (groups: Iterable<ItemState[]>, reason: Conflict['reason'], comparable: (a: ItemState, b: ItemState) => boolean): void => {
    for (const group of groups) {
      for (const state of group) {
        const others = group.filter((other) => other !== state && comparable(state, other) && !superseding.has(pairKey(state, other)));
        if (others.length > 0) state.conflicts.push({ reason, withItemIds: others.map((other) => other.item.itemId).sort(compareStrings) });
      }
    }
  };
  const keyed = live.filter((state) => state.item.key !== null);
  flagDuplicates(groupBy(keyed, (state) => `${state.item.projectId}\0${state.item.key}`).values(), 'duplicate-key', () => true);
  flagDuplicates(groupBy(keyed.filter((state) => state.item.kind === 'contract'), (state) => state.item.key!).values(), 'duplicate-contract-owner', (a, b) => a.item.projectId !== b.item.projectId);
}

/** 대체를 반영한 뒤 충돌을 찾는다. 입력을 고치지 않으므로 미리 계산하는 데도 쓴다. */
function settle(states: readonly ItemState[]): ItemState[] {
  const supersessions = supersessionsOf(states);
  const settled = applySupersessions(states, supersessions);
  detectConflicts(settled, supersessions);
  return settled;
}

export function resolveGeneration(items: readonly GenerationItem[], sources: ReadonlyMap<string, SourceFacts>): ResolvedItem[] {
  const resolveReference = createReferenceResolver(items);
  const pathBasisCheck = createPathBasisCheck(items);
  const factsOf = (item: GenerationItem): SourceFacts => sources.get(item.sourceId)!;
  const evaluate = (item: GenerationItem, basis: BasisResult[], links: LinkRecord[]): StatusResolution =>
    resolveBaseStatus({
      declared: item.declaredStatus,
      rawDeclared: item.declaredStatusRaw,
      basis,
      rule: item.rule,
      codeLinks: links.filter((link) => link.relation === 'code' || link.relation === 'test'),
    });

  const declaredCheck = pathBasisCheck(cannotBackBasis);
  const firstPass = items.map((item): ItemState => {
    const links = linksOf(item, factsOf(item), resolveReference);
    return { item, links, resolution: evaluate(item, directBasis(item, factsOf(item), declaredCheck), links), conflicts: [] };
  });
  const previewed = new Map(settle(firstPass).map((state) => [state.item.itemId, state]));
  const retiredOrContested = ({ resolution, conflicts }: ItemState): boolean => resolution.status === 'deprecated' || conflicts.length > 0;
  const previewCheck = pathBasisCheck((target) => cannotBackBasis(target) || retiredOrContested(previewed.get(target.itemId)!));
  const pathRechecked = new Map(firstPass.map(({ item, links }) => [item.itemId, evaluate(item, directBasis(item, factsOf(item), previewCheck), links)]));

  // item 근거의 대상은 다른 item 근거로 올라간 상태를 볼 수 없으므로 연쇄되지 않고 순환이 서로를 확정하지 못한다.
  // path 근거는 1차에서 확정된 항목도 다시 본다. 그 근거를 잃은 대상은 item 근거가 될 수 없다
  const states: ItemState[] = firstPass.map((state) => {
    const { item, links } = state;
    const basis = directBasis(item, factsOf(item), previewCheck).map((ref) => {
      if (ref.kind !== 'item') return ref;
      const reference = resolveReference(ref.value, item);
      if (reference === null || !('target' in reference)) return ref;
      const { target } = reference;
      if (target.documentPk === item.documentPk || retiredOrContested(previewed.get(target.itemId)!) || !isConfirmed(pathRechecked.get(target.itemId)!.status)) return ref;
      return { ...ref, resolved: true, targetItemId: target.itemId };
    });
    return { ...state, resolution: evaluate(item, basis, links) };
  });

  return settle(states).map(({ item, resolution, links, conflicts }) => ({
    itemPk: item.itemPk,
    baseStatus: resolution.status,
    effectiveStatus: conflicts.length > 0 ? 'conflicted' : resolution.status,
    reason: resolution.reason,
    basis: resolution.basis,
    conflicts: conflicts.sort(compareConflicts),
    links,
  }));
}
