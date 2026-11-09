import { isKind, normalizeStatus, type BasisRef, type Diagnostic, type Kind, type ParsedItem, type SourceRule } from '../model.js';
import { sha256 } from '../util/hash.js';
import { mergeRelations, parseFields, type ParsedFields } from './fields.js';
import { parseFrontmatter, type DocumentMeta } from './frontmatter.js';
import { scanMarkdown, wholeDocumentSection } from './markdown.js';

export interface BuildDocumentInput {
  sourceId: string;
  projectId: string;
  path: string;
  text: string;
  rule?: SourceRule | null;
  defaultKind?: Kind;
}

export interface BuiltDocument {
  title: string;
  lineCount: number;
  diagnostics: Diagnostic[];
  items: ParsedItem[];
}

interface StatusLayer {
  statusRaw: string | null;
  basisRefs: BasisRef[];
}

/** 상태와 근거를 함께 물려받는다. 다른 상태를 선언한 층의 근거가 이 상태를 뒷받침해서는 안 된다. */
function declaredFromChain(chain: readonly StatusLayer[]): StatusLayer {
  const statusRaw = chain.find((layer) => layer.statusRaw !== null)?.statusRaw ?? null;
  const status = statusRaw === null ? null : normalizeStatus(statusRaw);
  const usable = (layer: StatusLayer): boolean => statusRaw === null || layer.statusRaw === null || normalizeStatus(layer.statusRaw) === status;
  return { statusRaw, basisRefs: chain.find((layer) => layer.basisRefs.length > 0 && usable(layer))?.basisRefs ?? [] };
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
}

function appliesToOf(fields: ParsedFields, meta: DocumentMeta): ParsedItem['appliesTo'] {
  const scoped = fields.global || fields.paths.length > 0;
  return {
    global: scoped ? fields.global : meta.appliesTo.global,
    paths: scoped ? fields.paths : meta.appliesTo.paths,
    phases: fields.phases.length > 0 ? fields.phases : meta.appliesTo.phases,
    conditions: fields.conditions ?? meta.appliesTo.conditions,
  };
}

export function buildDocumentItems(input: BuildDocumentInput): BuiltDocument {
  const { sourceId, projectId, path, text } = input;
  const rule = input.rule ?? null;
  const scanned = scanMarkdown(text);
  const { meta, diagnostics: metaDiagnostics } = parseFrontmatter(scanned.frontmatter);
  const diagnostics = [...metaDiagnostics];
  if (scanned.frontmatterError !== null) diagnostics.push({ code: 'invalid-frontmatter', message: scanned.frontmatterError });
  const title = meta.title ?? scanned.firstH1 ?? baseName(path);

  if (meta.statusRaw !== null && normalizeStatus(meta.statusRaw) === null) {
    diagnostics.push({ code: 'unknown-status-value', message: meta.statusRaw });
  }

  // 폐기 문서가 근거로 쓰이지 않고 frontmatter id를 참조할 수 있도록, 절이 없어도 선언이 있는 문서는 항목을 남긴다
  const sections = scanned.sections.length === 0 && (meta.id !== null || meta.statusRaw !== null) ? [wholeDocumentSection(scanned)] : scanned.sections;
  const parsed = sections.map((section) => parseFields(section.fieldLines));
  const layers = parsed.map((fields): StatusLayer => ({ statusRaw: fields.statusRaw ?? fields.informalStatusRaw, basisRefs: fields.basisRefs }));
  const frontmatterLayer: StatusLayer = { statusRaw: meta.statusRaw, basisRefs: meta.basisRefs };

  const items = sections.map((section, ordinal): ParsedItem => {
    const fields = parsed[ordinal]!;
    const ancestors = section.ancestors.map((index) => parsed[index]!);
    let fieldKind: Kind | null = null;
    if (fields.kind !== null) {
      if (isKind(fields.kind)) fieldKind = fields.kind;
      else diagnostics.push({ code: 'unknown-kind', message: fields.kind });
    }
    if (fields.statusRaw !== null && normalizeStatus(fields.statusRaw) === null) {
      diagnostics.push({ code: 'unknown-status-value', message: fields.statusRaw });
    }
    for (const value of fields.informalStatusValues) diagnostics.push({ code: 'unrecognized-status-field', message: value });

    const declared = declaredFromChain([layers[ordinal]!, ...section.ancestors.map((index) => layers[index]!), frontmatterLayer]);
    const { statusRaw } = declared;
    const ancestorConflicts = ancestors.flatMap((ancestor) => ancestor.relations.conflicts_with ?? []);
    return {
      ordinal,
      itemId: `${sourceId}:${path}#${section.anchor}`,
      projectId,
      key: section.key ?? (ordinal === 0 ? meta.id : null),
      anchor: section.anchor,
      unit: section.unit,
      kind: fieldKind ?? meta.kind ?? rule?.kind ?? input.defaultKind ?? 'reference',
      title: section.unit === 'document' ? title : section.title,
      headingPath: section.headingPath,
      content: section.content,
      contentSha256: sha256(section.content),
      startLine: section.startLine,
      endLine: section.endLine,
      declaredStatusRaw: statusRaw,
      declaredStatus: statusRaw === null ? null : normalizeStatus(statusRaw),
      basisRefs: declared.basisRefs,
      rule,
      mandatory: fields.mandatory || ancestors.some((ancestor) => ancestor.mandatory) || meta.mandatory || (rule?.mandatory ?? false),
      // 문서 별칭을 모든 항목에 주면 명시 키 조회가 문서 전체에 걸리므로 id를 받는 첫 항목에만 준다. 문서 제목도 같은 이유다
      aliases: ordinal === 0 ? [...new Set([...fields.aliases, ...meta.aliases, ...(meta.title ? [meta.title] : [])])] : fields.aliases,
      appliesTo: appliesToOf(fields, meta),
      relations: mergeRelations(meta.relations, ancestorConflicts.length > 0 ? { conflicts_with: ancestorConflicts } : {}, fields.relations),
    };
  });

  return { title, lineCount: scanned.lineCount, diagnostics, items };
}
