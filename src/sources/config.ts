import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { KnowledgeError } from '../errors.js';
import { BASE_STATUSES, KINDS, type Kind, type SourceRule } from '../model.js';
import { matchesGlob } from '../util/glob.js';

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const ruleSchema = z
  .strictObject({
    match: z.string().min(1),
    kind: z.enum(KINDS).optional(),
    status: z.enum(BASE_STATUSES).optional(),
    basis: z.string().optional(),
    mandatory: z.boolean().optional(),
  })
  .superRefine((rule, ctx) => {
    if ((rule.status === 'confirmed_policy' || rule.status === 'verified_experience') && !rule.basis?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['basis'], message: `status ${rule.status} requires a non-empty basis` });
    }
  });

const sourceSchema = z.strictObject({
  id: z.string().regex(ID),
  project: z.string().regex(ID),
  path: z.string().min(1),
  ref: z.string().min(1).default('HEAD'),
  include: z.array(z.string().min(1)).min(1),
  exclude: z.array(z.string().min(1)).default([]),
  defaultKind: z.enum(KINDS).default('reference'),
  rules: z.array(ruleSchema).default([]),
});

const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  database: z.strictObject({ path: z.string().min(1) }),
  index: z
    .strictObject({
      retainGenerations: z.number().int().min(1).default(5),
      maxFileBytes: z.number().int().positive().default(1048576),
    })
    .prefault({}),
  sources: z.array(sourceSchema).min(1).superRefine((sources, ctx) => {
    const seen = new Set<string>();
    sources.forEach((source, index) => {
      if (seen.has(source.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `duplicate source id ${source.id}` });
      seen.add(source.id);
    });
  }),
});

export interface SourceConfig {
  id: string;
  project: string;
  /** 절대 경로 */
  path: string;
  ref: string;
  include: string[];
  exclude: string[];
  defaultKind: Kind;
  rules: SourceRule[];
  maxFileBytes: number;
}

export interface SourcesConfig {
  schemaVersion: 1;
  configPath: string;
  database: { path: string };
  index: { retainGenerations: number; maxFileBytes: number };
  sources: SourceConfig[];
}

function invalid(configPath: string, issues: { path: string; message: string }[]): KnowledgeError {
  return new KnowledgeError('config-invalid', `원본 설정이 올바르지 않습니다: ${configPath}`, { issues });
}

export function loadSourcesConfig(path: string): SourcesConfig {
  const configPath = resolve(path);
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'unreadable';
    throw new KnowledgeError('config-invalid', `원본 설정을 읽을 수 없습니다: ${configPath}`, { reason, path: configPath });
  }

  let raw: unknown;
  try {
    raw = parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw invalid(configPath, [{ path: '', message: (error as Error).message }]);
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw invalid(configPath, result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }

  const base = dirname(configPath);
  const { database, index, sources } = result.data;
  return {
    schemaVersion: 1,
    configPath,
    database: { path: resolve(base, database.path) },
    index,
    sources: sources.map((source) => ({ ...source, path: resolve(base, source.path), maxFileBytes: index.maxFileBytes })),
  };
}

/** 규칙은 먼저 일치한 하나만 적용한다. */
export function findRule(rules: readonly SourceRule[], path: string): SourceRule | null {
  return rules.find((rule) => matchesGlob(rule.match, path)) ?? null;
}
