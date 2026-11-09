import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeError } from '../errors.js';
import { MIGRATIONS, REQUIRED_TABLES, SCHEMA_VERSION } from './schema.js';

const BUSY_TIMEOUT = 'PRAGMA busy_timeout=5000';
// BUSY, LOCKED, READONLY, IOERR, CORRUPT, FULL, CANTOPEN, NOTADB
const UNAVAILABLE_CODES = new Set([5, 6, 8, 10, 11, 13, 14, 26]);

type SchemaState = 'empty' | 'older' | 'current' | 'newer' | 'foreign';

/** 저장소 장애와 코드 결함은 종료 코드가 달라야 하므로 SQLite 오류를 나눠서 옮긴다. */
export function guardStore<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const failure = error as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown };
    if (failure.code !== 'ERR_SQLITE_ERROR' || typeof failure.errcode !== 'number') throw error;
    const detail = { errcode: failure.errcode, errstr: failure.errstr };
    // errcode에는 확장 코드가 올 수 있고 하위 8비트가 기본 코드다
    if (UNAVAILABLE_CODES.has(failure.errcode & 0xff)) {
      throw new KnowledgeError('store-unavailable', `색인 저장소를 사용할 수 없습니다: ${String(failure.errstr)}`, detail);
    }
    throw new KnowledgeError('internal-error', `색인 저장소 작업이 실패했습니다: ${String(failure.message)}`, detail);
  }
}

export function classifySchema(version: number, objectCount: number, latest: number = SCHEMA_VERSION): SchemaState {
  if (version > latest) return 'newer';
  if (version === 0) return objectCount > 0 ? 'foreign' : 'empty';
  return version < latest ? 'older' : 'current';
}

/** user_version은 다른 프로그램도 쓸 수 있고 색인이 손상되어도 남으므로 버전만으로는 이 프로젝트의 색인인지 알 수 없다. */
function hasRequiredTables(db: DatabaseSync): boolean {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[];
  const tables = new Set(rows.map((row) => row.name));
  return REQUIRED_TABLES.every((table) => tables.has(table));
}

function schemaState(db: DatabaseSync): { state: SchemaState; version: number } {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
  const { objects } = db.prepare('SELECT count(*) AS objects FROM sqlite_master').get() as unknown as { objects: number };
  const state = classifySchema(version, objects);
  if (state === 'newer') throw new KnowledgeError('store-unavailable', '이 버전이 지원하지 않는 색인 스키마입니다', { reason: 'unsupported-schema', version });
  if (state === 'foreign' || (state === 'current' && !hasRequiredTables(db))) throw new KnowledgeError('store-unavailable', '이 프로젝트의 색인이 아닌 데이터베이스입니다', { reason: 'unknown-database' });
  return { state, version };
}

function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    // 다른 프로세스가 먼저 끝냈을 수 있으므로 쓰기 잠금을 잡은 뒤 다시 읽는다
    const { version } = schemaState(db);
    for (let next = version; next < SCHEMA_VERSION; next++) db.exec(MIGRATIONS[next]!);
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 여러 조회가 같은 스냅샷을 보도록 한 트랜잭션으로 묶는다. */
  read<T>(fn: (db: DatabaseSync) => T): T {
    return guardStore(() => {
      this.db.exec('BEGIN DEFERRED');
      try {
        return fn(this.db);
      } finally {
        if (this.db.isTransaction) this.db.exec('COMMIT');
      }
    });
  }

  close(): void {
    this.db.close();
  }
}

/** 실패하면 연결을 남기지 않는다. Windows에서는 열린 연결이 파일 삭제를 막는다. */
function open(path: string, readOnly: boolean, prepare: (db: DatabaseSync) => void): Store {
  return guardStore(() => {
    const db = new DatabaseSync(path, { readOnly });
    try {
      prepare(db);
      return new Store(db);
    } catch (error) {
      db.close();
      throw error;
    }
  });
}

export function openForRead(path: string): Store {
  if (!existsSync(path)) throw new KnowledgeError('index-missing', '색인 데이터베이스가 없습니다', { reason: 'no-database', path });
  return open(path, true, (db) => {
    db.exec(BUSY_TIMEOUT);
    const { state, version } = schemaState(db);
    if (state === 'empty') throw new KnowledgeError('index-missing', '게시된 색인이 없습니다', { reason: 'no-generation' });
    if (state === 'older') throw new KnowledgeError('index-missing', '색인 스키마가 오래되어 다시 색인해야 합니다', { reason: 'schema-mismatch', version });
  });
}

export function openForWrite(path: string): Store {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    throw new KnowledgeError('store-unavailable', `색인 디렉터리를 만들 수 없습니다: ${dirname(path)}`, { errno: failure.code ?? null, message: failure.message });
  }
  return open(path, false, (db) => {
    db.exec(BUSY_TIMEOUT);
    // 남의 데이터베이스의 저널 모드를 바꾸면 안 되므로 스키마를 먼저 확인한다
    schemaState(db);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db);
  });
}
