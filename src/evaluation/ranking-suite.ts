import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { KnowledgeError } from '../errors.js';
import { KINDS } from '../model.js';
import { loadRetrievalConfig, type RetrievalConfig } from '../profiles/config.js';
import { sha256 } from '../util/hash.js';

/** 저장소의 평가 폴더. 실제 자료 평가 묶음은 여기에 둘 수 없다. */
const REPOSITORY_EVALS = fileURLToPath(new URL('../../../evals/', import.meta.url));

const locationSchema = z.strictObject({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  sourceId: z.string().min(1).optional(),
});

const answerFields = { grade: z.number().int().min(1).max(3).optional(), required: z.boolean().optional() };
const relevantSchema = z.union([z.strictObject({ id: z.string().min(1), ...answerFields }), z.strictObject({ location: locationSchema, ...answerFields })]);

/** 실행 방식(직접 순위·문맥)과 변형이 정하는 필드는 사례가 정하지 못한다. 정하면 변형끼리 비교할 수 없다. */
const RUN_CONTROLLED = ['profile', 'responseVersion', 'include', 'limit', 'ranker', 'segments', 'budget'] as const;
const requestSchema = z.record(z.string(), z.unknown()).superRefine((request, ctx) => {
  for (const field of RUN_CONTROLLED) if (Object.hasOwn(request, field)) ctx.addIssue({ code: 'custom', path: [field], message: `${field}는 평가 실행이 정합니다` });
});

const caseSchema = z.strictObject({
  id: z.string().min(1),
  request: requestSchema,
  relevant: z.array(relevantSchema).min(1),
  judgment: z.enum(['provisional', 'reviewed']).optional(),
  expectKinds: z.array(z.enum(KINDS)).optional(),
  context: z
    .strictObject({
      include: z.strictObject({ mandatory: z.boolean().optional(), dependencies: z.boolean().optional(), links: z.boolean().optional() }).optional(),
      budget: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  note: z.string().optional(),
});

const suiteSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    suite: z.string().min(1),
    profile: z.enum(['master', 'code']),
    corpus: z.enum(['synthetic', 'real']),
    fixture: z.boolean().optional(),
    judgments: z.enum(['provisional', 'reviewed']),
    workspace: z.string().min(1).optional(),
    defaults: z.strictObject({ request: requestSchema }).optional(),
    cases: z.array(caseSchema).min(1),
  })
  .superRefine((suite, ctx) => {
    const seen = new Set<string>();
    suite.cases.forEach((testCase, index) => {
      if (seen.has(testCase.id)) ctx.addIssue({ code: 'custom', path: ['cases', index, 'id'], message: `duplicate case id ${testCase.id}` });
      seen.add(testCase.id);
    });
    // 합성 자료는 저장소 안의 fixture로만, 실제 자료는 호출자가 고른 설정(--config/--db)으로만 평가한다
    if (suite.corpus === 'synthetic' && (suite.fixture !== true || suite.workspace === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['corpus'], message: '합성 평가 묶음에는 fixture: true와 workspace가 있어야 합니다' });
    }
    if (suite.corpus === 'real' && (suite.fixture === true || suite.workspace !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['corpus'], message: '실제 자료 평가 묶음에는 fixture와 workspace를 둘 수 없습니다. --config와 --db로 색인을 고릅니다' });
    }
  });

export type RankingLocation = z.infer<typeof locationSchema>;
export type RelevantEntry = z.infer<typeof relevantSchema>;
export type RankingCase = z.infer<typeof caseSchema>;

export interface RankingSuite extends Omit<z.infer<typeof suiteSchema>, 'workspace'> {
  file: string;
  sha256: string;
  workspace: string | null;
}

const variantSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  description: z.string().optional(),
  request: z
    .strictObject({
      ranker: z.enum(['legacy', 'bm25']).optional(),
      segments: z.boolean().optional(),
      quota: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  retrieval: z.strictObject({ config: z.string().min(1).optional(), flatKindWeights: z.boolean().optional() }).optional(),
});

const variantsSchema = z
  .strictObject({ schemaVersion: z.literal(1), baseline: z.string().optional(), variants: z.array(variantSchema).min(1) })
  .superRefine((file, ctx) => {
    const ids = file.variants.map((variant) => variant.id);
    ids.forEach((id, index) => {
      if (ids.indexOf(id) !== index) ctx.addIssue({ code: 'custom', path: ['variants', index, 'id'], message: `duplicate variant id ${id}` });
    });
    if (file.baseline !== undefined && !ids.includes(file.baseline)) ctx.addIssue({ code: 'custom', path: ['baseline'], message: `baseline이 변형 목록에 없습니다: ${file.baseline}` });
  });

export interface RankingVariant {
  id: string;
  description: string | null;
  request: { ranker?: 'legacy' | 'bm25'; segments?: boolean; quota?: Record<string, unknown> };
  retrieval: RetrievalConfig;
  retrievalConfigPath: string;
  retrievalConfigSha256: string;
  flatKindWeights: boolean;
}

export interface RankingVariants {
  file: string | null;
  baseline: string;
  variants: RankingVariant[];
}

function evalFailed(message: string, detail: Record<string, unknown>): KnowledgeError {
  return new KnowledgeError('eval-failed', message, detail);
}

function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function readYaml(file: string, reason: 'suite-invalid' | 'variants-invalid' = 'suite-invalid'): { text: string; raw: unknown } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').replace(/^﻿/, '');
    return { text, raw: parse(text) };
  } catch (error) {
    throw evalFailed(`평가 파일을 읽을 수 없습니다: ${file}`, { reason, file, message: (error as Error).message });
  }
}

/**
 * 평가 묶음 파일의 형식 번호. 1이면 기존 평가, 2면 순위 평가다. 읽지 못하는 파일은 undefined로 두어 기존 평가의 loadSuite가
 * 예전과 같은 순서와 문구로 실패하게 한다.
 */
export function suiteSchemaVersionOf(file: string): unknown {
  let raw: unknown;
  try {
    raw = readYaml(file).raw;
  } catch {
    return undefined;
  }
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).schemaVersion : undefined;
}

/** '..real.yaml'처럼 '..'로 시작하는 이름도 evals 안이므로, 상위 디렉터리로 가는 경로만 밖으로 본다. */
export function insideRepositoryEvals(file: string): boolean {
  const path = relative(REPOSITORY_EVALS, file);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function loadRankingSuite(file: string): RankingSuite {
  const { text, raw } = readYaml(file);
  const result = suiteSchema.safeParse(raw);
  if (!result.success) throw evalFailed(`평가 묶음의 형식이 올바르지 않습니다: ${file}`, { reason: 'suite-invalid', file, issues: issuesOf(result.error) });
  // 실제 프로젝트 자료의 질의와 정답을 저장소에 남기지 않는다
  if (result.data.corpus === 'real' && insideRepositoryEvals(file)) throw evalFailed(`실제 자료 평가 묶음은 저장소의 evals 아래에 둘 수 없습니다: ${file}`, { reason: 'real-suite-in-repository', file });
  const { workspace, ...suite } = result.data;
  return { ...suite, file, sha256: sha256(text), workspace: workspace === undefined ? null : resolve(dirname(file), workspace) };
}

/** 같은 순위 방식에서 kindWeights만 1로 두면 종류 가중치의 효과를 따로 볼 수 있다. phaseWeights는 그대로 둔다. */
function flattenKindWeights(config: RetrievalConfig): RetrievalConfig {
  const flat = (weights: Record<string, number>): Record<string, number> => Object.fromEntries(Object.keys(weights).map((kind) => [kind, 1]));
  const profiles = Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => [name, { ...profile, kindWeights: flat(profile.kindWeights) }]));
  return { ...config, profiles } as RetrievalConfig;
}

function variantOf(entry: z.infer<typeof variantSchema>, baseDir: string | null, defaultConfigPath: string): RankingVariant {
  const configPath = entry.retrieval?.config === undefined || baseDir === null ? defaultConfigPath : resolve(baseDir, entry.retrieval.config);
  const loaded = loadRetrievalConfig(configPath);
  const flatKindWeights = entry.retrieval?.flatKindWeights === true;
  return {
    id: entry.id,
    description: entry.description ?? null,
    request: entry.request ?? {},
    retrieval: flatKindWeights ? flattenKindWeights(loaded) : loaded,
    retrievalConfigPath: configPath,
    retrievalConfigSha256: sha256(readFileSync(configPath)),
    flatKindWeights,
  };
}

/** 변형 파일이 없으면 기본 검색과 같은 변형 하나로 평가한다. */
export function loadVariants(file: string | undefined, defaultConfigPath: string): RankingVariants {
  if (file === undefined) return { file: null, baseline: 'default', variants: [variantOf({ id: 'default', description: '기본 검색(legacy, 조각 없음)' }, null, defaultConfigPath)] };
  const path = resolve(file);
  const { raw } = readYaml(path, 'variants-invalid');
  const result = variantsSchema.safeParse(raw);
  if (!result.success) throw evalFailed(`변형 파일의 형식이 올바르지 않습니다: ${path}`, { reason: 'variants-invalid', file: path, issues: issuesOf(result.error) });
  const variants = result.data.variants.map((entry) => variantOf(entry, dirname(path), defaultConfigPath));
  return { file: path, baseline: result.data.baseline ?? variants[0]!.id, variants };
}
