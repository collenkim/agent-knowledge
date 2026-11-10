import { parse } from 'yaml';
import { z } from 'zod';
import { isKind, isPhase, RELATIONS, type AppliesTo, type BasisRef, type Diagnostic, type HttpOperation, type Kind, type Relations } from '../model.js';
import { compareStrings } from '../util/compare.js';
import { normalizeRepoPath } from '../util/paths.js';
import { isHttpOperation, mergeOperations, normalizeCodePath, operationsOf, parseBasisRefs } from './fields.js';

const stringList = z.union([z.string(), z.array(z.string())]).transform((value) => (Array.isArray(value) ? value : [value]));

const frontmatterSchema = z.looseObject({
  id: z.string().optional(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  status_basis: stringList.optional(),
  mandatory: z.boolean().optional(),
  applies_to: z
    .looseObject({
      global: z.boolean().optional(),
      paths: stringList.optional(),
      phases: stringList.optional(),
      conditions: stringList.optional(),
    })
    .optional(),
  relations: z.record(z.string(), stringList).optional(),
  aliases: stringList.optional(),
  fixture: z.boolean().optional(),
});

export interface DocumentMeta {
  id: string | null;
  title: string | null;
  kind: Kind | null;
  statusRaw: string | null;
  basisRefs: BasisRef[];
  mandatory: boolean;
  appliesTo: AppliesTo;
  relations: Relations;
  aliases: string[];
  operations: HttpOperation[];
}

const EMPTY_META: DocumentMeta = {
  id: null,
  title: null,
  kind: null,
  statusRaw: null,
  basisRefs: [],
  mandatory: false,
  appliesTo: { global: false, paths: [], phases: [], conditions: null },
  relations: {},
  aliases: [],
  operations: [],
};

interface ParsedFrontmatter {
  meta: DocumentMeta;
  diagnostics: Diagnostic[];
}

/** 다른 키의 형식 오류 때문에 작성자의 폐기·미확인 선언까지 잃지 않게 상태와 근거만 살린다. */
function salvaged(raw: unknown, message: string): ParsedFrontmatter {
  const { status, status_basis: basis } = raw as Record<string, unknown>;
  const basisValues = stringList.safeParse(basis);
  return {
    meta: { ...EMPTY_META, statusRaw: typeof status === 'string' ? status : null, basisRefs: basisValues.success ? parseBasisRefs(basisValues.data) : [] },
    diagnostics: [{ code: 'invalid-frontmatter', message }],
  };
}

interface FrontmatterVerdict {
  isFrontmatter: boolean;
  /** YAML로 읽지 못했을 때의 오류. */
  error: string | null;
}

/** 문서 맨 앞의 구분선 사이 글이 문서 메타데이터로 버려지지 않게, 인식하는 키가 있는 매핑만 frontmatter로 본다. */
export function frontmatterVerdict(text: string): FrontmatterVerdict {
  // 빈 영역은 본문으로 돌려도 얻을 내용이 없다
  if (text.trim() === '') return { isFrontmatter: true, error: null };
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    return { isFrontmatter: false, error: (error as Error).message };
  }
  const isMapping = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
  return { isFrontmatter: isMapping && Object.keys(frontmatterSchema.shape).some((key) => Object.hasOwn(raw as object, key)), error: null };
}

export function parseFrontmatter(text: string | null): ParsedFrontmatter {
  if (text === null) return { meta: EMPTY_META, diagnostics: [] };
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    // trim()이 비웠다고 본 영역도 YAML은 거부할 수 있다(탭 뒤의 전각 공백 등)
    return { meta: EMPTY_META, diagnostics: [{ code: 'invalid-frontmatter', message: (error as Error).message }] };
  }
  if (raw === null) return { meta: EMPTY_META, diagnostics: [] };
  const result = frontmatterSchema.safeParse(raw);
  if (!result.success) return salvaged(raw, result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));

  const data = result.data;
  const diagnostics: Diagnostic[] = [];
  let kind: Kind | null = null;
  if (data.kind !== undefined) {
    if (isKind(data.kind)) kind = data.kind;
    else diagnostics.push({ code: 'unknown-kind', message: data.kind });
  }

  const relations: Relations = {};
  const operations: HttpOperation[][] = [];
  for (const relation of RELATIONS) {
    const values = data.relations?.[relation];
    if (!values) continue;
    if (relation === 'code' || relation === 'test') operations.push(values.flatMap((value) => operationsOf(value, relation)));
    const targets = relation === 'code' || relation === 'test' ? values.flatMap((value) => normalizeCodePath(value) ?? []) : values;
    if (targets.length > 0) relations[relation] = [...new Set(targets)].sort(compareStrings);
  }

  const applies = data.applies_to;
  // `GET:/auth/x` 같은 HTTP 작업은 적용 경로가 아니라 적용 조건이다
  // 항목 필드처럼 백틱으로 감싼 작업(`POST /a`)도 작업으로 본다. 경로 값의 백틱 처리는 이전 그대로다
  const isOperation = (value: string): boolean => isHttpOperation(value.replaceAll('`', '').trim());
  const scopeOperations = (applies?.paths ?? []).filter(isOperation);
  operations.push(scopeOperations.flatMap((value) => operationsOf(value, 'scope')));
  return {
    meta: {
      id: data.id ?? null,
      title: data.title ?? null,
      kind,
      statusRaw: data.status ?? null,
      basisRefs: parseBasisRefs(data.status_basis ?? []),
      mandatory: data.mandatory ?? false,
      appliesTo: {
        global: applies?.global ?? false,
        paths: (applies?.paths ?? []).flatMap((path) => (isOperation(path) ? [] : (normalizeRepoPath(path) ?? []))),
        phases: (applies?.phases ?? []).filter(isPhase),
        conditions: scopeOperations.length === 0 ? (applies?.conditions?.join(' ') ?? null) : [...(applies?.conditions ?? []), ...scopeOperations].join(' '),
      },
      relations,
      aliases: data.aliases ?? [],
      operations: mergeOperations(...operations),
    },
    diagnostics,
  };
}
