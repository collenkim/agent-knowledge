import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { KnowledgeError } from '../errors.js';
import { guardStore, type Store } from './store.js';

/** 임대는 세대를 GC에서 지키는 표시일 뿐이다. 작업 상태·승인·완료 같은 실행 상태는 담지 않는다. */
export const LEASE_TTL_SECONDS = { default: 86_400, min: 60, max: 2_592_000 } as const;
export const MAX_LIVE_LEASES = 1024;
const MAX_HOLDER_LENGTH = 200;
const CONTROL = /\p{Cc}/u;

export interface Lease {
  leaseId: string;
  generation: number;
  holder: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

export interface LeaseView extends Lease {
  expired: boolean;
}

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

const LEASE_COLUMNS = 'lease_id AS leaseId, generation, holder, acquired_at AS acquiredAt, renewed_at AS renewedAt, expires_at AS expiresAt';

export function checkTtl(ttlSeconds: number): number {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < LEASE_TTL_SECONDS.min || ttlSeconds > LEASE_TTL_SECONDS.max) {
    throw new KnowledgeError('invalid-request', `임대 기간은 ${LEASE_TTL_SECONDS.min}~${LEASE_TTL_SECONDS.max}초 사이의 정수여야 합니다`, { reason: 'invalid-ttl', ttlSeconds, ...LEASE_TTL_SECONDS });
  }
  return ttlSeconds;
}

export function checkHolder(holder: unknown): string {
  if (typeof holder !== 'string' || holder.length === 0 || holder.length > MAX_HOLDER_LENGTH || CONTROL.test(holder)) {
    throw new KnowledgeError('invalid-request', `임대 보유자 이름은 제어 문자 없이 1~${MAX_HOLDER_LENGTH}자여야 합니다`, { reason: 'invalid-holder' });
  }
  return holder;
}

function expiry(now: Date, ttlSeconds: number): string {
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
}

export function readIndexId(db: DatabaseSync): string | null {
  const found = db.prepare("SELECT value FROM meta WHERE key = 'index_id'").get() as unknown as { value: string } | undefined;
  return found?.value ?? null;
}

function activeGeneration(db: DatabaseSync): number {
  const found = db.prepare("SELECT value FROM meta WHERE key = 'active_generation'").get() as unknown as { value: string } | undefined;
  if (found === undefined) throw new KnowledgeError('index-missing', '게시된 색인이 없습니다', { reason: 'no-generation' });
  return Number(found.value);
}

export function assertIndexId(db: DatabaseSync, expected: string | undefined): void {
  if (expected === undefined) return;
  const actual = readIndexId(db);
  if (actual !== expected) throw new KnowledgeError('index-missing', '요청한 색인 식별자와 데이터베이스가 다릅니다', { reason: 'index-id-mismatch', expected, actual });
}

/** 유효한 임대가 상한에 닿았으면 거절한다. index는 수집 전에 한 번 미리 보고, 실제 판정은 insertLease가 잠금 아래에서 한다. */
export function assertLeaseRoom(db: DatabaseSync, now: Date): void {
  const { live } = db.prepare('SELECT count(*) AS live FROM generation_leases WHERE expires_at > ?').get(now.toISOString()) as unknown as { live: number };
  if (live >= MAX_LIVE_LEASES) throw new KnowledgeError('invalid-request', `유효한 임대가 너무 많습니다(최대 ${MAX_LIVE_LEASES}개)`, { reason: 'too-many-leases', max: MAX_LIVE_LEASES });
}

/** 쓰기 트랜잭션 안에서 부른다. 세대 존재와 개수 상한을 같은 잠금 아래에서 확인해야 GC와 엇갈리지 않는다. */
export function insertLease(db: DatabaseSync, generation: number, holder: string, ttlSeconds: number, now: Date): Lease {
  const exists = db.prepare('SELECT 1 AS found FROM generations WHERE generation = ?').get(generation);
  if (!exists) throw new KnowledgeError('index-missing', `보존된 세대가 아닙니다: ${generation}`, { reason: 'generation-not-found', generation });
  assertLeaseRoom(db, now);
  const at = now.toISOString();
  const lease: Lease = { leaseId: randomUUID(), generation, holder, acquiredAt: at, renewedAt: at, expiresAt: expiry(now, ttlSeconds) };
  db.prepare('INSERT INTO generation_leases(lease_id, generation, holder, acquired_at, renewed_at, expires_at) VALUES(?,?,?,?,?,?)').run(lease.leaseId, generation, holder, lease.acquiredAt, lease.renewedAt, lease.expiresAt);
  return lease;
}

function inWriteTransaction<T>(store: Store, fn: (db: DatabaseSync) => T): T {
  const { db } = store;
  return guardStore(() => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  });
}

export interface AcquireLeaseOptions {
  /** 생략하면 같은 트랜잭션에서 읽은 활성 세대에 건다. 읽은 뒤 거는 사이에 세대가 바뀌지 않는다. */
  generation?: number;
  holder: string;
  ttlSeconds?: number;
  indexId?: string;
  clock?: Clock;
}

/** 타입 검사를 거치지 않은 JSON 호출자도 있다. null 같은 값을 '생략'으로 보아 활성 세대에 조용히 걸면 안 된다. */
function checkGeneration(generation: unknown): number | undefined {
  if (generation === undefined) return undefined;
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
    throw new KnowledgeError('invalid-request', '임대할 세대는 1 이상의 정수여야 합니다', { reason: 'invalid-generation', generation: typeof generation === 'number' ? generation : String(generation) });
  }
  return generation;
}

export function acquireLease(store: Store, options: AcquireLeaseOptions): Lease {
  const ttl = checkTtl(options.ttlSeconds ?? LEASE_TTL_SECONDS.default);
  const holder = checkHolder(options.holder);
  const generation = checkGeneration(options.generation);
  const now = (options.clock ?? systemClock)();
  return inWriteTransaction(store, (db) => {
    assertIndexId(db, options.indexId);
    return insertLease(db, generation ?? activeGeneration(db), holder, ttl, now);
  });
}

function findLease(db: DatabaseSync, leaseId: string): Lease | undefined {
  return db.prepare(`SELECT ${LEASE_COLUMNS} FROM generation_leases WHERE lease_id = ?`).get(leaseId) as unknown as Lease | undefined;
}

/** 만료된 임대는 이미 세대를 지키지 못했을 수 있으므로 되살리지 않는다. 새로 얻어야 한다. */
export function renewLease(store: Store, leaseId: string, ttlSeconds: number = LEASE_TTL_SECONDS.default, clock: Clock = systemClock): Lease {
  const ttl = checkTtl(ttlSeconds);
  const now = clock();
  return inWriteTransaction(store, (db) => {
    const lease = findLease(db, leaseId);
    if (!lease) throw new KnowledgeError('not-found', `임대가 없습니다: ${leaseId}`, { reason: 'lease-not-found', leaseId });
    if (lease.expiresAt <= now.toISOString()) throw new KnowledgeError('not-found', `임대가 만료되었습니다: ${leaseId}`, { reason: 'lease-expired', leaseId, expiresAt: lease.expiresAt });
    const renewed: Lease = { ...lease, renewedAt: now.toISOString(), expiresAt: expiry(now, ttl) };
    db.prepare('UPDATE generation_leases SET renewed_at = ?, expires_at = ? WHERE lease_id = ?').run(renewed.renewedAt, renewed.expiresAt, leaseId);
    return renewed;
  });
}

/** 같은 임대를 여러 번 풀어도 된다. 작업이 끝났는지 모르는 호출자가 정리 단계에서 안심하고 부를 수 있어야 한다. */
export function releaseLease(store: Store, leaseId: string): { released: boolean } {
  return inWriteTransaction(store, (db) => ({ released: Number(db.prepare('DELETE FROM generation_leases WHERE lease_id = ?').run(leaseId).changes) > 0 }));
}

export function listLeases(db: DatabaseSync, holder: string | undefined, now: Date): LeaseView[] {
  const rows = (
    holder === undefined
      ? db.prepare(`SELECT ${LEASE_COLUMNS} FROM generation_leases ORDER BY lease_id`).all()
      : db.prepare(`SELECT ${LEASE_COLUMNS} FROM generation_leases WHERE holder = ? ORDER BY lease_id`).all(holder)
  ) as unknown as Lease[];
  const at = now.toISOString();
  return rows.map((lease) => ({ ...lease, expired: lease.expiresAt <= at }));
}

/** GC 트랜잭션 안에서 부른다. 만료된 임대를 지우고 아직 유효한 임대가 지키는 세대를 돌려준다. */
export function leasedGenerations(db: DatabaseSync, now: Date): number[] {
  const at = now.toISOString();
  db.prepare('DELETE FROM generation_leases WHERE expires_at <= ?').run(at);
  return (db.prepare('SELECT DISTINCT generation FROM generation_leases ORDER BY generation').all() as unknown as { generation: number }[]).map((row) => row.generation);
}
