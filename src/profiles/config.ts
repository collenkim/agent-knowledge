import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { KnowledgeError } from '../errors.js';
import { EFFECTIVE_STATUSES, KINDS, PHASES } from '../model.js';
import { canonicalJson, sha256 } from '../util/hash.js';

const RESERVED_SECTIONS = new Set(['mandatory', 'dependencies']);
const weight = z.number().positive();
const count = z.number().int().min(0);

const profileSchema = z
  .strictObject({
    limit: z.number().int().min(1).max(50),
    excerptChars: z.number().int().positive(),
    linkDepth: count,
    linkLimit: count,
    mandatoryLimit: count,
    dependencyLimit: count,
    allowedLinkKinds: z.union([z.literal('*'), z.array(z.enum(KINDS))]),
    requiresSingleProject: z.boolean(),
    includeCodeLocations: z.boolean(),
    kindWeights: z.record(z.enum(KINDS), weight),
    phaseWeights: z.partialRecord(z.enum(PHASES), z.partialRecord(z.enum(KINDS), weight)).optional(),
    sections: z.array(z.strictObject({ id: z.string().min(1), title: z.string().min(1), kinds: z.array(z.enum(KINDS)).min(1) })).min(1),
  })
  .superRefine((profile, ctx) => {
    const placed = profile.sections.flatMap((section) => section.kinds);
    for (const kind of KINDS) {
      const times = placed.filter((candidate) => candidate === kind).length;
      if (times !== 1) ctx.addIssue({ code: 'custom', path: ['sections'], message: `kind ${kind} must belong to exactly one section (found ${times})` });
    }
    const ids = new Set<string>();
    profile.sections.forEach((section, index) => {
      if (ids.has(section.id) || RESERVED_SECTIONS.has(section.id)) ctx.addIssue({ code: 'custom', path: ['sections', index, 'id'], message: `section id ${section.id} is duplicate or reserved` });
      ids.add(section.id);
    });
  });

const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  vector: z.strictObject({ enabled: z.boolean() }),
  ranking: z.strictObject({
    statusWeights: z.record(z.enum(EFFECTIVE_STATUSES), weight),
    fieldBoosts: z.strictObject({ keyOrAlias: z.number().min(0), title: z.number().min(0), pathOverlap: z.number().min(0), explicitKey: z.number().min(0) }),
    fieldWeights: z.strictObject({ key_aliases: weight, title: weight, headings: weight, body: weight }),
    candidateLimit: z.number().int().min(1),
    /** 선택형 BM25 순위(`ranker: bm25`)의 매개변수. 생략하면 BM25_DEFAULTS를 쓴다. 기본 순위에는 영향이 없다. */
    bm25: z
      .strictObject({
        k1: z.number().min(0).optional(),
        b: z.number().min(0).max(1).optional(),
        fieldWeights: z.strictObject({ key_aliases: weight, title: weight, headings: weight, body: weight }).optional(),
      })
      .optional(),
  }),
  /** 응답 형식 2의 질의 상한. 생략하면 QUERY_LIMIT_DEFAULTS를 쓴다. 기존 형식 요청에는 적용하지 않는다. */
  limits: z
    .strictObject({
      maxQueries: z.number().int().min(1).max(256).optional(),
      maxQueryChars: z.number().int().min(1).optional(),
      maxTermsPerQuery: z.number().int().min(1).optional(),
      maxTotalTerms: z.number().int().min(1).optional(),
    })
    .optional(),
  profiles: z.strictObject({ master: profileSchema, code: profileSchema }),
});

export type RetrievalConfig = z.infer<typeof configSchema>;
export type ProfileConfig = RetrievalConfig['profiles']['master'];
export type RankingConfig = RetrievalConfig['ranking'];

export const BM25_DEFAULTS = { k1: 1.2, b: 0.75, fieldWeights: { key_aliases: 4, title: 3, headings: 2, body: 1 } } as const;
export const QUERY_LIMIT_DEFAULTS = { maxQueries: 32, maxQueryChars: 4000, maxTermsPerQuery: 48, maxTotalTerms: 256 } as const;

export interface Bm25Config {
  k1: number;
  b: number;
  fieldWeights: { key_aliases: number; title: number; headings: number; body: number };
}

export type QueryLimits = { -readonly [K in keyof typeof QUERY_LIMIT_DEFAULTS]: number };

export function bm25Of(ranking: RankingConfig): Bm25Config {
  return { k1: ranking.bm25?.k1 ?? BM25_DEFAULTS.k1, b: ranking.bm25?.b ?? BM25_DEFAULTS.b, fieldWeights: { ...BM25_DEFAULTS.fieldWeights, ...ranking.bm25?.fieldWeights } };
}

export function queryLimitsOf(config: RetrievalConfig): QueryLimits {
  return { ...QUERY_LIMIT_DEFAULTS, ...config.limits };
}

/** 같은 세대라도 검색 설정이 다르면 결과가 다르므로, 결과를 고정하려는 소비자는 이 해시를 함께 기록한다. 기본값을 채운 뒤 계산한다. */
export function configHashOf(config: RetrievalConfig, profile: 'master' | 'code'): string {
  const ranking = { ...config.ranking, bm25: bm25Of(config.ranking) };
  return sha256(canonicalJson({ schemaVersion: config.schemaVersion, ranking, limits: queryLimitsOf(config), profile: config.profiles[profile] }));
}

export function loadRetrievalConfig(path: string): RetrievalConfig {
  const configPath = resolve(path);
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'unreadable';
    throw new KnowledgeError('config-invalid', `검색 설정을 읽을 수 없습니다: ${configPath}`, { reason, path: configPath });
  }

  const invalid = (issues: { path: string; message: string }[]): KnowledgeError => new KnowledgeError('config-invalid', `검색 설정이 올바르지 않습니다: ${configPath}`, { issues });
  let raw: unknown;
  try {
    raw = parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw invalid([{ path: '', message: (error as Error).message }]);
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) throw invalid(result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  // 켜져 있다고 믿게 두면 벡터 검색 품질을 확인했다는 뜻으로 읽힌다
  if (result.data.vector.enabled) throw new KnowledgeError('config-invalid', '벡터 검색은 아직 구현되지 않았습니다', { reason: 'vector-not-implemented', path: configPath });
  return result.data;
}
