import { Database, type Statement } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { availableParallelism, freemem, homedir, totalmem } from 'node:os';
import { basename, join } from 'node:path';
import type { AcquireResult, Demand, Lease, Mail, Peer, Recommendation, Request, Resources, Snapshot } from './protocol.ts';

const SCHEMA_VERSION = 2;
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

const dimensions = ['cpu', 'memoryMB', 'gpu'] as const;
function validateResources(value: Resources, name: string): void {
  if (!value || dimensions.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)
    || value.gpu > 100) {
    throw new Error(`${name}需要非负整数 cpu、memoryMB、gpu（GPU 为 0..100）`);
  }
}
function fits(value: Resources, limit: Resources): boolean {
  return dimensions.every(key => value[key] <= limit[key]);
}
function recommendations(entries: { ownerId: string; demand: Demand }[], capacity: Resources): Recommendation[] {
  // Fit a runnable cohort rather than deadlocking every elastic holder when
  // more requests arrive than can satisfy all minima at once. Leases come first;
  // pending requests keep arrival order, but unrelated resources can pass.
  const remainingMinimum = { ...capacity };
  const targets: (Resources | null)[] = entries.map(entry => {
    if (!fits(entry.demand.minimum, remainingMinimum)) return null;
    for (const key of dimensions) remainingMinimum[key] -= entry.demand.minimum[key];
    return { ...entry.demand.minimum };
  });
  for (const key of dimensions) {
    let remaining = remainingMinimum[key];
    let candidates = entries.map((_, index) => index).filter(index => targets[index] && targets[index]![key] < entries[index]!.demand.preferred[key]);
    while (remaining > 0 && candidates.length) {
      const share = Math.max(1, Math.floor(remaining / candidates.length));
      for (const index of candidates) {
        const amount = Math.min(share, remaining, entries[index]!.demand.preferred[key] - targets[index]![key]);
        targets[index]![key] += amount;
        remaining -= amount;
      }
      candidates = candidates.filter(index => targets[index]![key] < entries[index]!.demand.preferred[key]);
    }
  }
  return entries.map((entry, index) => ({ ownerId: entry.ownerId, target: targets[index] ?? null }));
}

export class Coordinator {
  readonly id = randomUUID();
  private readonly db: Database;
  private readonly statements = new Map<string, Statement>();
  private readonly label: string;
  private readonly cwd: string;
  private started = false;
  private closed = false;
  private readonly capacity: Resources;

  constructor(options: { directory?: string; label?: string; cwd?: string; capacity?: Resources } = {}) {
    const capacity = options.capacity ?? {
      cpu: availableParallelism(), memoryMB: Math.floor(totalmem() / 1_048_576 * 0.8), gpu: 100,
    };
    validateResources(capacity, '机器预算');
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
        if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) {
          throw new Error(`OMPmail 数据库版本不兼容：${version}，当前支持 ${SCHEMA_VERSION}`);
        }
        if (version === SCHEMA_VERSION) return;
        if (version === 1) {
          const peers = this.statement<{ pid: number }>('SELECT pid FROM peers').all();
          if (peers.some(peer => isAlive(peer.pid))) {
            throw new Error('OMPmail 资源协议升级需要旧版所有窗口先完成任务并退出，再统一重启；不能与旧独占协议混用');
          }
          this.db.exec('DELETE FROM peers; DROP TABLE lease; DROP TABLE requests;');
        } else {
          const existing = this.statement("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
          if (existing.length) throw new Error('OMPmail 状态数据库包含未识别的旧表，拒绝覆盖');
          this.db.exec(`
            CREATE TABLE peers (
              id TEXT PRIMARY KEY, pid INTEGER NOT NULL, label TEXT NOT NULL, cwd TEXT NOT NULL,
              started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL
            );
            CREATE TABLE mail (
              id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id TEXT NOT NULL,
              recipient_id TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
              kind TEXT NOT NULL CHECK (kind IN ('message', 'request', 'release')),
              text TEXT NOT NULL, created_at INTEGER NOT NULL
            );
            CREATE INDEX mail_recipient ON mail(recipient_id, id);
            CREATE INDEX mail_created ON mail(created_at);
          `);
        }
        this.db.exec(`
          CREATE TABLE budget (slot INTEGER PRIMARY KEY CHECK (slot = 1), resources TEXT NOT NULL);
          CREATE TABLE leases (
            owner_id TEXT PRIMARY KEY REFERENCES peers(id) ON DELETE CASCADE,
            reason TEXT NOT NULL, acquired_at INTEGER NOT NULL,
            demand TEXT NOT NULL, allocation TEXT NOT NULL
          );
          CREATE TABLE requests (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id TEXT NOT NULL UNIQUE REFERENCES peers(id) ON DELETE CASCADE,
            reason TEXT NOT NULL, requested_at INTEGER NOT NULL, refreshed_at INTEGER NOT NULL,
            demand TEXT NOT NULL
          );
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
        this.statement('INSERT INTO budget(slot, resources) VALUES (1, ?)').run(JSON.stringify(capacity));
      }).immediate();
      const budget = this.statement<{ resources: string }>('SELECT resources FROM budget WHERE slot = 1').get();
      if (!budget) throw new Error('OMPmail 缺少机器资源预算');
      this.capacity = JSON.parse(budget.resources) as Resources;
      if (options.capacity && dimensions.some(key => options.capacity![key] !== this.capacity[key])) {
        throw new Error('OMPmail 同一协调组的机器资源预算必须一致');
      }
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
      return this.readSnapshot();
    }).immediate();
  }

  acquire(reason: string, demand: Demand, allocation?: Resources): AcquireResult {
    boundedText(reason, '任务原因', 500);
    validateResources(demand?.minimum, 'minimum');
    validateResources(demand?.preferred, 'preferred');
    if (!fits(demand.minimum, demand.preferred) || !fits(demand.minimum, this.capacity)
      || dimensions.every(key => demand.minimum[key] === 0)) {
      throw new Error('minimum 必须不超过 preferred 和机器预算，minimum 不能全为零');
    }
    if (allocation !== undefined) {
      validateResources(allocation, 'allocation');
      if (!fits(demand.minimum, allocation) || !fits(allocation, demand.preferred)) {
        throw new Error('allocation 必须位于 minimum 与 preferred 之间');
      }
    }
    this.start();
    return this.db.transaction((): AcquireResult => {
      const now = Date.now();
      this.prune(now);
      const before = this.readSnapshot();
      const held = before.leases.find(lease => lease.ownerId === this.id);
      if (held && allocation === undefined && (!fits(demand.minimum, held.allocation) || !fits(held.allocation, demand.preferred))) {
        throw new Error('更改需求范围需提供 allocation；降低额度前必须先实际降低所有运行任务的总占用');
      }
      if (!held) {
        const existing = before.queue.find(request => request.ownerId === this.id);
        this.statement(`INSERT INTO requests(owner_id, reason, requested_at, refreshed_at, demand) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(owner_id) DO UPDATE SET reason = excluded.reason, refreshed_at = excluded.refreshed_at, demand = excluded.demand`)
          .run(this.id, reason, now, now, JSON.stringify(demand));
        if (!existing || JSON.stringify(existing.demand) !== JSON.stringify(demand)) this.deliver('*', 'request', reason, now);
      }
      const state = this.readSnapshot();
      const entries = [...state.leases, ...state.queue].map(entry => ({
        ownerId: entry.ownerId, demand: entry.ownerId === this.id ? demand : entry.demand,
      }));
      const target = recommendations(entries, this.capacity).find(entry => entry.ownerId === this.id)?.target;
      const available = { ...this.capacity };
      for (const lease of state.leases) {
        if (lease.ownerId !== this.id) for (const key of dimensions) available[key] -= lease.allocation[key];
      }
      // Reservations may not have reached the OS yet. Conservatively subtract other
      // windows' commitments from free RAM rather than promise the same headroom twice.
      const otherMemory = this.capacity.memoryMB - available.memoryMB;
      available.memoryMB = Math.min(available.memoryMB,
        (held?.allocation.memoryMB ?? 0) + Math.max(0, state.freeMemoryMB - otherMemory));
      const proposed = allocation !== undefined ? { ...allocation } : { cpu: 0, memoryMB: 0, gpu: 0 };
      if (allocation === undefined) {
        for (const key of dimensions) {
          proposed[key] = Math.max(held?.allocation[key] ?? 0, Math.min(available[key], (target ?? demand.minimum)[key]));
        }
      }
      const updated = fits(demand.minimum, proposed) && fits(proposed, available);
      if (updated) {
        this.statement(`INSERT INTO leases(owner_id, reason, acquired_at, demand, allocation) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(owner_id) DO UPDATE SET reason = excluded.reason, demand = excluded.demand, allocation = excluded.allocation`)
          .run(this.id, reason, held?.acquiredAt ?? now, JSON.stringify(demand), JSON.stringify(proposed));
        this.statement('DELETE FROM requests WHERE owner_id = ?').run(this.id);
      }
      const snapshot = this.readSnapshot();
      const grant = snapshot.leases.find(lease => lease.ownerId === this.id);
      return { ...snapshot, status: grant ? 'granted' : 'queued', ownerId: this.id, updated, allocation: grant?.allocation ?? null };
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

  private readSnapshot(): Snapshot {
    const peers = this.statement('SELECT id, pid, label, cwd, started_at AS startedAt, heartbeat_at AS heartbeatAt FROM peers ORDER BY started_at, id').all() as Peer[];
    const leases = this.statement<Omit<Lease, 'demand' | 'allocation'> & { demand: string; allocation: string }>(
      'SELECT owner_id AS ownerId, reason, acquired_at AS acquiredAt, demand, allocation FROM leases ORDER BY acquired_at, owner_id',
    ).all().map(row => ({ ...row, demand: JSON.parse(row.demand) as Demand, allocation: JSON.parse(row.allocation) as Resources }));
    const queue = this.statement<Omit<Request, 'demand'> & { demand: string }>(
      'SELECT owner_id AS ownerId, reason, requested_at AS requestedAt, demand FROM requests ORDER BY sequence',
    ).all().map(row => ({ ...row, demand: JSON.parse(row.demand) as Demand }));
    return {
      selfId: this.id, peers, capacity: { ...this.capacity },
      freeMemoryMB: Math.floor(freemem() / 1_048_576 * 0.8),
      leases, queue, recommendations: recommendations([...leases, ...queue], this.capacity),
    };
  }

  private releaseLease(now: number): boolean {
    const lease = this.statement<{ reason: string }>('SELECT reason FROM leases WHERE owner_id = ?').get(this.id);
    if (!lease) return false;
    this.statement('DELETE FROM leases WHERE owner_id = ?').run(this.id);
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
