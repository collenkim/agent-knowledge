import { KnowledgeError } from '../errors.js';

export type Progress = (message: string) => void;

export function progressWriter(quiet: boolean): Progress {
  return quiet ? () => {} : (message) => void process.stderr.write(`${message}\n`);
}

/** --quiet는 진행 메시지만 줄인다. 문서 진단까지 숨기면 잘못된 원본을 알아챌 방법이 없다. */
export function writeDiagnostic(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** 제어 측이 마지막 줄을 JSON으로 읽으므로 기본 출력은 한 줄이어야 한다. */
export function writeDocument(document: unknown, pretty: boolean): void {
  process.stdout.write(`${JSON.stringify(document, null, pretty ? 2 : undefined)}\n`);
}

export function errorBody(error: KnowledgeError): { code: string; message: string; detail: unknown } {
  return { code: error.code, message: error.message, detail: error.detail ?? {} };
}

export function errorDocument(command: string | null, error: KnowledgeError): Record<string, unknown> {
  return { schema: 'agent-knowledge.error', schemaVersion: 1, ok: false, status: 'error', command, error: errorBody(error) };
}

export function asKnowledgeError(error: unknown): KnowledgeError {
  if (error instanceof KnowledgeError) return error;
  // 스택은 진단용이라 stderr로만 보낸다. stdout에는 정해진 봉투만 나가야 한다
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  return new KnowledgeError('internal-error', error instanceof Error ? error.message : String(error));
}
