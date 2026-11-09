export const EXIT_CODES = {
  usage: 2,
  'invalid-request': 2,
  'config-invalid': 7,
  'source-unavailable': 8,
  'index-failed': 8,
  'index-conflict': 8,
  'invalid-scope': 4,
  'index-missing': 5,
  'store-unavailable': 6,
  'not-found': 3,
  'eval-failed': 9,
  'internal-error': 1,
} as const;

export type ErrorCode = keyof typeof EXIT_CODES;

export class KnowledgeError extends Error {
  readonly code: ErrorCode;
  readonly detail?: unknown;

  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'KnowledgeError';
    this.code = code;
    this.detail = detail;
  }
}
