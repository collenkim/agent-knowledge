export const KINDS = ['overview', 'responsibility', 'glossary', 'policy', 'contract', 'dependency', 'architecture', 'convention', 'test-strategy', 'quality', 'data-dictionary', 'api-catalog', 'business-rule', 'feature', 'flow', 'plan', 'experience', 'handoff', 'reference'] as const;
export const BASE_STATUSES = ['confirmed_policy', 'observed_behavior', 'verified_experience', 'unverified', 'deprecated'] as const;
export const EFFECTIVE_STATUSES = [...BASE_STATUSES, 'conflicted'] as const;
export const RELATIONS = ['policy', 'feature', 'flow', 'contract', 'dependency', 'code', 'test', 'conflicts_with', 'supersedes', 'related'] as const;
const UNITS = ['document', 'section', 'entry'] as const;
export const PHASES = ['analysis', 'impact', 'design', 'plan', 'implement', 'check', 'test', 'review', 'integrate', 'deliver'] as const;
export const DEFAULT_LINK_KINDS = ['contract', 'dependency', 'api-catalog'] as const;

export type Kind = (typeof KINDS)[number];
export type BaseStatus = (typeof BASE_STATUSES)[number];
export type EffectiveStatus = (typeof EFFECTIVE_STATUSES)[number];
export type Relation = (typeof RELATIONS)[number];
export type Unit = (typeof UNITS)[number];
export type Phase = (typeof PHASES)[number];

export const STATUS_LABELS: Record<EffectiveStatus, string> = {
  confirmed_policy: '확정 정책',
  observed_behavior: '코드에서 관찰한 동작',
  verified_experience: '검증된 경험',
  unverified: '미확인 자료',
  deprecated: '폐기된 자료',
  conflicted: '충돌',
};

const STATUS_VOCABULARY = new Map<string, BaseStatus>([
  // 출력에 쓰는 표시 이름을 작성자가 그대로 적어도 선언으로 읽는다. `충돌`은 판정 결과라 선언할 수 없다
  ...BASE_STATUSES.map((status): [string, BaseStatus] => [STATUS_LABELS[status], status]),
  ['confirmed_policy', 'confirmed_policy'],
  ['confirmed', 'confirmed_policy'],
  ['확정', 'confirmed_policy'],
  ['observed_behavior', 'observed_behavior'],
  ['observed', 'observed_behavior'],
  ['관찰', 'observed_behavior'],
  ['코드 관찰', 'observed_behavior'],
  ['verified_experience', 'verified_experience'],
  ['verified', 'verified_experience'],
  ['검증됨', 'verified_experience'],
  ['unverified', 'unverified'],
  ['미확인', 'unverified'],
  ['가설', 'unverified'],
  ['deprecated', 'deprecated'],
  ['폐기', 'deprecated'],
  ['폐기됨', 'deprecated'],
  ['대체됨', 'deprecated'],
]);

/** `확정 예정`이 확정으로 읽히면 안 되므로 토큰을 뽑지 않고 전체 일치만 인정한다. */
export function normalizeStatus(raw: string): BaseStatus | null {
  return STATUS_VOCABULARY.get(raw.trim().replace(/\s+/g, ' ').toLowerCase()) ?? null;
}

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

export interface AppliesTo {
  global: boolean;
  paths: string[];
  phases: Phase[];
  conditions: string | null;
}

export interface BasisRef {
  kind: 'path' | 'commit' | 'item' | 'verify' | 'opaque';
  value: string;
  anchor?: string;
}

export type Relations = Partial<Record<Relation, string[]>>;

export interface SourceRule {
  match: string;
  kind?: Kind;
  status?: BaseStatus;
  basis?: string;
  mandatory?: boolean;
}

export interface Diagnostic {
  code: string;
  message: string;
}

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'] as const;

/** `PATCH /auth/x`, `GET:/auth/x`처럼 적은 HTTP 작업. 파일 경로가 아니므로 경로 연결이나 적용 경로로 쓰지 않는다. */
export interface HttpOperation {
  method: (typeof HTTP_METHODS)[number];
  path: string;
  field: 'scope' | 'code' | 'test';
}

export type InformalSyntax = 'plain' | 'table' | 'ordered-list' | 'quote';

/** 상태 값을 정한 층과, 그 절에 적힌 비공식 상태 표기. 판정에는 쓰지 않고 출력에서 원문을 보존하는 데 쓴다. */
export interface StatusDeclaration {
  origin: 'field' | 'informal' | 'ancestor-field' | 'ancestor-informal' | 'frontmatter' | null;
  informal: { raw: string; normalized: BaseStatus; syntax: InformalSyntax; applied: boolean }[];
}

/** 긴 항목을 의미 단위로 나눈 조각. 항목 자체는 그대로 두고 검색·발췌 단위로만 쓴다. ID는 `<항목 ID>#<순번>`이고 앵커에는 `#`이 들어가지 않는다. */
export interface ParsedSegment {
  ordinal: number;
  segmentId: string;
  startLine: number;
  endLine: number;
  content: string;
  contentSha256: string;
  tokenCount: number;
}

export interface ParsedItem {
  ordinal: number;
  itemId: string;
  projectId: string;
  key: string | null;
  anchor: string;
  unit: Unit;
  kind: Kind;
  title: string;
  headingPath: string[];
  content: string;
  contentSha256: string;
  startLine: number;
  endLine: number;
  declaredStatusRaw: string | null;
  declaredStatus: BaseStatus | null;
  basisRefs: BasisRef[];
  rule: SourceRule | null;
  mandatory: boolean;
  aliases: string[];
  appliesTo: AppliesTo;
  relations: Relations;
  operations: HttpOperation[];
  declaration: StatusDeclaration;
  tokenCount: number;
  segments: ParsedSegment[];
}
