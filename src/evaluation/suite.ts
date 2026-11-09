import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { EXIT_CODES, KnowledgeError, type ErrorCode } from '../errors.js';
import { compareStrings } from '../util/compare.js';

const ERROR_CODES = Object.keys(EXIT_CODES) as [ErrorCode, ...ErrorCode[]];

const locationSchema = z.strictObject({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  sourceId: z.string().min(1).optional(),
});

const expectSchema = z
  .strictObject({
    status: z.enum(['ok', 'no-results']).optional(),
    items: z.array(z.string().min(1)).default([]),
    locations: z.array(locationSchema).default([]),
    sections: z.record(z.string(), z.array(z.string().min(1))).default({}),
    absent: z.array(z.string().min(1)).default([]),
    unconfirmed: z.array(z.string().min(1)).default([]),
    error: z.enum(ERROR_CODES).optional(),
  })
  // 아무것도 단언하지 않는 사례는 결과와 무관하게 통과한다
  .refine(
    ({ status, items, locations, sections, absent, unconfirmed, error }) =>
      status !== undefined || error !== undefined || items.length > 0 || locations.length > 0 || absent.length > 0 || unconfirmed.length > 0 || Object.values(sections).some((ids) => ids.length > 0),
    { message: 'expect에는 단언이 하나 이상 있어야 합니다' },
  );

// 요청 부분은 검색 코드가 직접 검증해야 잘못된 요청을 기대하는 사례가 그대로 도달한다
const caseSchema = z.strictObject({
  id: z.string().min(1),
  query: z.unknown().optional(),
  scope: z.unknown(),
  filters: z.unknown().optional(),
  task: z.unknown().optional(),
  version: z.unknown().optional(),
  limit: z.unknown().optional(),
  expect: expectSchema,
});

const suiteSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    suite: z.string().min(1),
    profile: z.enum(['master', 'code']),
    workspace: z.string().min(1).optional(),
    cases: z.array(caseSchema).min(1),
  })
  .superRefine((suite, ctx) => {
    const seen = new Set<string>();
    suite.cases.forEach((testCase, index) => {
      if (seen.has(testCase.id)) ctx.addIssue({ code: 'custom', path: ['cases', index, 'id'], message: `duplicate case id ${testCase.id}` });
      seen.add(testCase.id);
    });
  });

export type EvalCase = z.infer<typeof caseSchema>;
export type EvalLocation = z.infer<typeof locationSchema>;

export interface EvalSuite extends Omit<z.infer<typeof suiteSchema>, 'workspace'> {
  file: string;
  /** 절대 경로. null이면 설정된 색인을 그대로 쓴다. */
  workspace: string | null;
}

function evalFailed(message: string, detail: Record<string, unknown>): KnowledgeError {
  return new KnowledgeError('eval-failed', message, detail);
}

/** 디렉터리는 바로 아래의 YAML만 읽는다. fixtures처럼 평가 묶음이 아닌 하위 폴더를 건드리지 않기 위해서다. */
export function findSuiteFiles(paths: readonly string[]): string[] {
  const files = paths.flatMap((input) => {
    const path = resolve(input);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) throw evalFailed(`평가 묶음을 찾을 수 없습니다: ${path}`, { reason: 'suite-not-found', path });
    if (!stat.isDirectory()) return [path];
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareStrings)
      .map((name) => join(path, name));
  });
  if (files.length === 0) throw evalFailed('실행할 평가 묶음이 없습니다', { reason: 'no-suites', paths });
  return [...new Set(files)];
}

export function loadSuite(file: string): EvalSuite {
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    throw evalFailed(`평가 묶음을 읽을 수 없습니다: ${file}`, { reason: 'suite-invalid', file, message: (error as Error).message });
  }
  const result = suiteSchema.safeParse(raw);
  if (!result.success) throw evalFailed(`평가 묶음의 형식이 올바르지 않습니다: ${file}`, { reason: 'suite-invalid', file, issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
  const { workspace, ...suite } = result.data;
  return { ...suite, file, workspace: workspace === undefined ? null : resolve(dirname(file), workspace) };
}
