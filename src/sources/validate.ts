import { statSync } from 'node:fs';
import { KnowledgeError } from '../errors.js';
import { collectSource } from './collect.js';
import type { SourceConfig, SourcesConfig } from './config.js';
import { assertGitToplevel, isDirty, resolveCommit } from './git.js';

interface SourceIssue {
  code: string;
  message: string;
}

interface SourceReport {
  id: string;
  project: string;
  path: string;
  ref: string;
  commit: string | null;
  matchedDocuments: number;
  ok: boolean;
  errors: SourceIssue[];
  warnings: SourceIssue[];
}

interface ValidationReport {
  ok: boolean;
  sources: SourceReport[];
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function knowledgeMessage(error: unknown): string {
  if (error instanceof KnowledgeError) return error.message;
  throw error;
}

function checkSource(source: SourceConfig, report: SourceReport): void {
  const fail = (code: string, message: string): void => void report.errors.push({ code, message });

  if (!isDirectory(source.path)) return fail('path-not-found', `경로가 없습니다: ${source.path}`);
  try {
    assertGitToplevel(source.path);
  } catch (error) {
    const notToplevel = error instanceof KnowledgeError && (error.detail as { reason?: string }).reason === 'not-git-toplevel';
    return fail(notToplevel ? 'not-git-toplevel' : 'not-a-git-repository', knowledgeMessage(error));
  }

  try {
    report.commit = resolveCommit(source.path, source.ref);
  } catch (error) {
    return fail('ref-unresolved', knowledgeMessage(error));
  }

  try {
    const { candidates } = collectSource(source);
    report.matchedDocuments = candidates.length;
    if (candidates.length === 0) {
      report.warnings.push({ code: 'no-matching-documents', message: 'include와 일치하는 추적 문서가 없습니다.' });
    } else if (isDirty(source.path, candidates.map((candidate) => candidate.path))) {
      report.warnings.push({ code: 'dirty-tracked-documents', message: '커밋되지 않은 변경은 색인되지 않습니다.' });
    }
  } catch (error) {
    fail('source-unavailable', knowledgeMessage(error));
  }
}

export function validateSources(cfg: SourcesConfig): ValidationReport {
  const sources = cfg.sources.map((source): SourceReport => {
    const report: SourceReport = {
      id: source.id,
      project: source.project,
      path: source.path,
      ref: source.ref,
      commit: null,
      matchedDocuments: 0,
      ok: false,
      errors: [],
      warnings: [],
    };
    checkSource(source, report);
    report.ok = report.errors.length === 0;
    return report;
  });
  return { ok: sources.every((source) => source.ok), sources };
}
