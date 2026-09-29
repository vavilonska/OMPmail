import { Database, type Statement } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AcquireResult, Lease, Mail, Peer, Request, Snapshot } from './protocol.ts';

const SCHEMA_VERSION = 1;
const REQUEST_TTL_MS = 120_000;
const MAIL_TTL_MS = 24 * 60 * 60 * 1_000;
const INBOX_LIMIT = 200;

function boundedText(value: string, name: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`${name}必须为非空文本，且不超过 ${limit} 个字符`);
  }
  return value;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves death. Permission errors and unknown platform errors
    // must not turn a possibly live process's permit into a second permit.
    return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH');
  }
}

export class Coordinator {
  readonly id = randomUUID();
  private readonly db: Database;
  private readonly statements = new Map<string, Statement>();
  private readonly label: string;
  private readonly cwd: string;
  private started = false;
  private closed = false;

  constructor(options: { directory?: string; label?: string; cwd?: string } = {}) {
    this.cwd = options.cwd ?? process.cwd();
    boundedText(this.cwd, '工作目录', 32_768);
    this.label = boundedText(options.label ?? (basename(this.cwd) || `omp-${process.pid}`).slice(0, 120), '窗口名称', 120);
    const directory = options.directory ?? process.env.OMPMAIL_DIR ?? join(homedir(), '.omp', 'ompmail');
    boundedText(directory, '状态目录', 32_768);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
    const filename = join(directory, 'state.sqlite');
    this.db = new Database(filename, { create: true, strict: true });
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      this.db.transaction(() => {
        const row = this.statement<{ user_version: number }>('PRAGMA user_version').get();
        if (!row) throw new Error('无法读取 OMPmail 数据库版本');
        const version = row.user_version;
        if (version !== 0 && version !== SCHEMA_VERSION) {
          throw new Error(`OMPmail 数据库版本不兼容：${version}，当前支持 ${SCHEMA_VERSION}`);
        }
        if (version === SCHEMA_VERSION) return;
        const existing = this.statement("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
        if (existing.length) throw new Error('OMPmail 状态数据库包含未识别的旧表，拒绝覆盖');
        this.db.exec(`
          CREATE TABLE peers (
            id TEXT PRIMARY KEY,
            pid INTEGER NOT NULL,
            label TEXT NOT NULL,
            cwd TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            heartbeat_at INTEGER NOT NULL
          );
          CREATE TABLE lease (
            slot INTEGER PRIMARY KEY CHECK (slot = 1),
            owner_id TEXT NOT NULL UNIQUE REFERENCES peers(id) ON DELETE CASCADE,
            reason TEXT NOT NULL,
            acquired_at INTEGER NOT NULL
          );
          CREATE TABLE requests (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id TEXT NOT NULL UNIQUE REFERENCES peers(id) ON DELETE CASCADE,
            reason TEXT NOT NULL,
            requested_at INTEGER NOT NULL,
            refreshed_at INTEGER NOT NULL
          );
          CREATE TABLE mail (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id TEXT NOT NULL,
            recipient_id TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('message', 'request', 'release')),
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX mail_recipient ON mail(recipient_id, id);
          CREATE INDEX mail_created ON mail(created_at);
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
      }).immediate();
      if (process.platform !== 'win32') chmodSync(filename, 0o600);
    } catch (error) {
      this.closeDatabase();
      throw error;
    }
  }

  start(): void {
    if (this.closed) throw new Error('OMPmail 协调器已关闭');
    if (this.started) return;
    this.db.transaction(() => {
      const now = Date.now();
      this.prune(now);
      this.statement('INSERT INTO peers(id, pid, label, cwd, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(this.id, process.pid, this.label, this.cwd, now, now);
    }).immediate();
    this.started = true;
  }

  heartbeat(): void {
    this.start();
    this.db.transaction(() => {
      const now = Date.now();
      this.prune(now);
      this.statement('UPDATE peers SET heartbeat_at = ? WHERE id = ?').run(now, this.id);
    }).immediate();
  }

  snapshot(): Snapshot {
    this.start();
    return this.db.transaction((): Snapshot => {
      this.prune(Date.now());
      const peers = this.statement('SELECT id, pid, label, cwd, started_at AS startedAt, heartbeat_at AS heartbeatAt FROM peers ORDER BY started_at, id').all() as Peer[];
      const queue = this.statement('SELECT owner_id AS ownerId, reason, requested_at AS requestedAt FROM requests ORDER BY sequence').all() as Request[];
      return { selfId: this.id, peers, lease: this.readLease(), queue };
    }).immediate();
  }

  acquire(reason: string): AcquireResult {
    boundedText(reason, '任务原因', 500);
    this.start();
    return this.db.transaction((): AcquireResult => {
      const now = Date.now();
      this.prune(now);
      let lease = this.readLease();
      if (lease?.ownerId === this.id) {
        return { status: 'granted', ownerId: this.id, position: 0, lease };
      }
      const existing = this.statement('SELECT sequence FROM requests WHERE owner_id = ?').get(this.id);
      if (existing) {
        this.statement('UPDATE requests SET reason = ?, refreshed_at = ? WHERE owner_id = ?').run(reason, now, this.id);
      } else {
        this.statement('INSERT INTO requests(owner_id, reason, requested_at, refreshed_at) VALUES (?, ?, ?, ?)').run(this.id, reason, now, now);
        this.deliver('*', 'request', reason, now);
      }
      const queue = this.statement('SELECT owner_id AS ownerId FROM requests ORDER BY sequence').all() as { ownerId: string }[];
      if (!lease && queue[0]?.ownerId === this.id) {
        this.statement('INSERT INTO lease(slot, owner_id, reason, acquired_at) VALUES (1, ?, ?, ?)').run(this.id, reason, now);
        this.statement('DELETE FROM requests WHERE owner_id = ?').run(this.id);
        lease = { ownerId: this.id, reason, acquiredAt: now };
        return { status: 'granted', ownerId: this.id, position: 0, lease };
      }
      return { status: 'queued', ownerId: this.id, position: queue.findIndex(entry => entry.ownerId === this.id) + 1, lease };
    }).immediate();
  }

  release(): boolean {
    this.start();
    return this.db.transaction(() => {
      const now = Date.now();
      this.prune(now);
      return this.releaseLease(now);
    }).immediate();
  }

  cancel(): boolean {
    this.start();
    return this.db.transaction(() => {
      this.prune(Date.now());
      return this.statement('DELETE FROM requests WHERE owner_id = ?').run(this.id).changes > 0;
    }).immediate();
  }

  send(to: string, text: string): number {
    boundedText(to, '收件人', 120);
    boundedText(text, '消息', 4_000);
    this.start();
    return this.db.transaction(() => {
      const now = Date.now();
      this.prune(now);
      return this.deliver(to, 'message', text, now);
    }).immediate();
  }

  inbox(): Mail[] {
    this.start();
    return this.db.transaction(() => {
      this.prune(Date.now());
      const messages = this.statement('SELECT id, sender_id AS "from", recipient_id AS "to", kind, text, created_at AS createdAt FROM mail WHERE recipient_id = ? ORDER BY id').all(this.id) as Mail[];
      this.statement('DELETE FROM mail WHERE recipient_id = ?').run(this.id);
      return messages;
    }).immediate();
  }

  close(): void {
    if (this.closed) return;
    try {
      if (this.started) {
        this.db.transaction(() => {
          const now = Date.now();
          this.prune(now);
          this.releaseLease(now);
          this.statement('DELETE FROM peers WHERE id = ?').run(this.id);
        }).immediate();
      }
    } finally {
      this.closed = true;
      this.closeDatabase();
    }
  }

  private statement<Row = unknown>(sql: string): Statement<Row> {
    let statement = this.statements.get(sql);
    if (!statement) {
      // prepare bypasses Bun's bounded query cache. Retain ownership even when
      // more SQL variants are used than that cache can hold.
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    // Each internal SQL string has one fixed result shape.
    return statement as Statement<Row>;
  }

  private closeDatabase(): void {
    try {
      for (const statement of this.statements.values()) statement.finalize();
    } finally {
      this.statements.clear();
      this.db.close();
    }
  }

  private readLease(): Lease | null {
    return this.statement('SELECT owner_id AS ownerId, reason, acquired_at AS acquiredAt FROM lease WHERE slot = 1').get() as Lease | null;
  }

  private releaseLease(now: number): boolean {
    const lease = this.readLease();
    if (lease?.ownerId !== this.id) return false;
    this.statement('DELETE FROM lease WHERE slot = 1 AND owner_id = ?').run(this.id);
    this.deliver('*', 'release', lease.reason, now);
    return true;
  }

  private prune(now: number): void {
    const peers = this.statement('SELECT id, pid FROM peers').all() as { id: string; pid: number }[];
    for (const peer of peers) {
      // PID reuse is deliberately conservative: an existing PID is retained,
      // even if its old heartbeat is stale. No heartbeat-based lease expiry.
      if (!isAlive(peer.pid)) this.statement('DELETE FROM peers WHERE id = ?').run(peer.id);
    }
    this.statement('DELETE FROM requests WHERE refreshed_at <= ?').run(now - REQUEST_TTL_MS);
    this.statement('DELETE FROM mail WHERE created_at <= ?').run(now - MAIL_TTL_MS);
  }

  private deliver(to: string, kind: Mail['kind'], text: string, now: number): number {
    const recipients = (to === '*'
      ? this.statement('SELECT id FROM peers WHERE id <> ?').all(this.id)
      : this.statement('SELECT id FROM peers WHERE id = ?').all(to)) as { id: string }[];
    if (to !== '*' && recipients.length === 0) throw new Error(`未知或已退出的收件人：${to}`);
    for (const recipient of recipients) {
      this.statement('INSERT INTO mail(sender_id, recipient_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(this.id, recipient.id, kind, text, now);
      this.statement('DELETE FROM mail WHERE recipient_id = ? AND id NOT IN (SELECT id FROM mail WHERE recipient_id = ? ORDER BY id DESC LIMIT ?)')
        .run(recipient.id, recipient.id, INBOX_LIMIT);
    }
    return recipients.length;
  }
}
