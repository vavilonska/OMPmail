import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator } from "../src/coordinator.ts";
import type { AcquireResult, Demand, Mail, Snapshot } from "../src/protocol.ts";

const fixture = fileURLToPath(new URL("./peer-worker.ts", import.meta.url));
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
type WorkerResponse = { sequence: number; value?: unknown; error?: string };

class Worker {
  readonly process;
  readonly ready: Promise<{ id: string; pid: number }>;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly stderr: Promise<string>;

  constructor(directory: string) {
    this.process = Bun.spawn([process.execPath, fixture, directory], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    this.stderr = new Response(this.process.stderr).text();
    this.ready = this.waitFor(0) as Promise<{ id: string; pid: number }>;
    void this.readOutput();
  }

  private waitFor(sequence: number): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    // A real deadline only bounds a hung external process; success is driven by its reply,
    // never by elapsed time. Fake clocks cannot detect an independent process deadlock.
    const timeout = setTimeout(() => {
      this.pending.delete(sequence);
      reject(new Error(`测试子进程响应超时: ${sequence}`));
    }, 15_000);
    this.pending.set(sequence, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    return promise;
  }

  private async readOutput(): Promise<void> {
    let failure: Error | undefined;
    try {
      const reader = this.process.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const response = JSON.parse(buffer.slice(0, end)) as WorkerResponse;
            buffer = buffer.slice(end + 1);
            const waiter = this.pending.get(response.sequence);
            this.pending.delete(response.sequence);
            if (response.error) waiter?.reject(new Error(response.error));
            else waiter?.resolve(response.value);
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      const diagnostics = await this.stderr;
      const error = failure ?? new Error(`测试子进程退出: ${diagnostics}`);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    }
  }

  async call<T>(action: string, fields: Record<string, unknown> = {}): Promise<T> {
    const sequence = ++this.sequence;
    const result = this.waitFor(sequence);
    this.process.stdin.write(`${JSON.stringify({ sequence, action, ...fields })}\n`);
    await this.process.stdin.flush();
    return await result as T;
  }

  async waitForExit(): Promise<number> {
    const { promise, reject } = Promise.withResolvers<never>();
    // Only bound a hung OS process; successful shutdown awaits exited, not a delay.
    // Fake timers cannot advance an independent child's pipe or process lifecycle.
    const timeout = setTimeout(() => {
      reject(new Error("测试子进程退出超时"));
    }, 15_000);
    try {
      return await Promise.race([this.process.exited, promise]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async kill(): Promise<void> {
    if (this.process.exitCode === null) this.process.kill();
    await this.waitForExit();
  }
}

async function withWorkers(count: number, run: (workers: Worker[], directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ompmail-test-"));
  const workers: Worker[] = [];
  try {
    // Do not await each startup: first-open schema creation really races.
    for (let index = 0; index < count; index++) workers.push(new Worker(directory));
    await Promise.all(workers.map(worker => worker.ready));
    await run(workers, directory);
  } finally {
    await Promise.all(workers.map(worker => worker.kill()));
    // Bun's async rm may reject Windows EBUSY without applying its retry options.
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function editDatabase(directory: string, sql: string, ...values: (string | number)[]): void {
  const database = new Database(join(directory, "state.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.query(sql).run(...values);
  } finally {
    database.close();
  }
}

const fixed = (cpu: number, memoryMB = 64, gpu = 0): Demand => ({
  minimum: { cpu, memoryMB, gpu }, preferred: { cpu, memoryMB, gpu },
});
const elastic: Demand = { minimum: { cpu: 2, memoryMB: 64, gpu: 0 }, preferred: { cpu: 8, memoryMB: 64, gpu: 0 } };

describe("真实进程的资源协商", () => {
  test("四窗口并发首次启动可同时获准，事务不会超额分配", async () => {
    await withWorkers(5, async workers => {
      const results = await Promise.all(workers.map(worker => worker.call<AcquireResult>("acquire", { demand: fixed(2) })));
      expect(results.filter(result => result.status === "granted")).toHaveLength(4);
      expect(results.filter(result => result.status === "queued")).toHaveLength(1);
      const snapshot = await workers[0]!.call<Snapshot>("snapshot");
      expect(new Set(snapshot.peers.map(peer => peer.pid)).size).toBe(5);
      expect(snapshot.leases.reduce((sum, lease) => sum + lease.allocation.cpu, 0)).toBe(8);
      expect(snapshot.queue).toHaveLength(1);
      const granted = results.findIndex(result => result.status === "granted");
      const waiting = results.findIndex(result => result.status === "queued");
      await workers[granted]!.call("release");
      expect((await workers[waiting]!.call<AcquireResult>("acquire", { demand: fixed(2) })).allocation?.cpu).toBe(2);
    });
  }, 30_000);

  test("先真实降额确认再并行，其他窗口结束后恢复首选额度", async () => {
    await withWorkers(3, async ([first, second, idle]) => {
      const firstId = (await first!.ready).id;
      expect((await first!.call<AcquireResult>("acquire", { demand: elastic })).allocation?.cpu).toBe(8);
      expect((await second!.call<AcquireResult>("acquire", { demand: elastic })).status).toBe("queued");
      const proposal = await first!.call<Snapshot>("snapshot");
      expect(proposal.recommendations.find(entry => entry.ownerId === firstId)?.target?.cpu).toBe(4);
      expect(proposal.leases[0]!.allocation.cpu).toBe(8);
      expect((await first!.call<AcquireResult>("acquire", { demand: elastic })).allocation?.cpu).toBe(8);
      const reduced = await first!.call<AcquireResult>("acquire", {
        demand: elastic, allocation: { cpu: 4, memoryMB: 64, gpu: 0 },
      });
      expect(reduced.updated).toBe(true);
      expect((await second!.call<AcquireResult>("acquire", { demand: elastic })).allocation?.cpu).toBe(4);
      expect((await idle!.call<Snapshot>("snapshot")).leases).toHaveLength(2);
      await second!.call("release");
      expect((await first!.call<Snapshot>("snapshot")).recommendations.find(entry => entry.ownerId === firstId)?.target?.cpu).toBe(8);
      expect((await first!.call<AcquireResult>("acquire", { demand: elastic })).allocation?.cpu).toBe(8);
    });
  }, 30_000);

  test("请求数超过可并行下限时仍协商可运行批次，不把所有弹性任务堵死", async () => {
    await withWorkers(5, async workers => {
      for (const worker of workers) await worker.call("acquire", { demand: elastic });
      const state = await workers[0]!.call<Snapshot>("snapshot");
      expect(state.recommendations.filter(item => item.target?.cpu === 2)).toHaveLength(4);
      expect(state.recommendations.filter(item => item.target === null)).toHaveLength(1);
      await workers[0]!.call("acquire", { demand: elastic, allocation: elastic.minimum });
      for (const worker of workers.slice(1, 4)) {
        expect((await worker.call<AcquireResult>("acquire", { demand: elastic })).allocation?.cpu).toBe(2);
      }
      expect((await workers[4]!.call<AcquireResult>("acquire", { demand: elastic })).status).toBe("queued");
      expect((await workers[0]!.call<Snapshot>("snapshot")).leases).toHaveLength(4);
    });
  }, 30_000);

  test("不可缩减任务才等待，GPU与CPU任务不被单队首串行化", async () => {
    await withWorkers(3, async ([cpu, waiting, gpu]) => {
      await cpu!.call("acquire");
      expect((await waiting!.call<AcquireResult>("acquire")).status).toBe("queued");
      const parallel = await gpu!.call<AcquireResult>("acquire", { demand: fixed(0, 64, 100) });
      expect(parallel.status).toBe("granted");
      expect(parallel.leases).toHaveLength(2);
      expect(parallel.recommendations.find(entry => entry.ownerId === parallel.queue[0]!.ownerId)?.target).toBeNull();
      expect(parallel.recommendations.find(entry => entry.ownerId === parallel.ownerId)?.target?.gpu).toBe(100);
      await cpu!.call("release");
      expect((await waiting!.call<AcquireResult>("acquire")).status).toBe("granted");
    });
  }, 30_000);

  test("增长失败保留原额度，内存和GPU也参与总量限制", async () => {
    await withWorkers(2, async ([first, second]) => {
      const demand: Demand = { minimum: { cpu: 1, memoryMB: 64, gpu: 20 }, preferred: { cpu: 8, memoryMB: 1024, gpu: 100 } };
      await first!.call("acquire", { demand, allocation: { cpu: 2, memoryMB: 128, gpu: 50 } });
      expect((await second!.call<AcquireResult>("acquire", { demand: fixed(2, 64, 60) })).status).toBe("queued");
      await second!.call("acquire", { demand: fixed(2, 64, 50) });
      const failed = await first!.call<AcquireResult>("acquire", { demand, allocation: { cpu: 4, memoryMB: 128, gpu: 60 } });
      expect(failed.status).toBe("granted");
      expect(failed.updated).toBe(false);
      expect(failed.allocation).toEqual({ cpu: 2, memoryMB: 128, gpu: 50 });
      expect(failed.leases.reduce((sum, lease) => sum + lease.allocation.gpu, 0)).toBe(100);
    });
  }, 30_000);

  test("定向和广播只读一次，重复申请不重复通知，释放可见", async () => {
    await withWorkers(3, async ([sender, target, other]) => {
      const senderId = (await sender!.ready).id;
      const targetId = (await target!.ready).id;
      expect(await sender!.call<number>("send", { to: targetId, text: "定向协调" })).toBe(1);
      expect(await sender!.call<number>("send", { to: "*", text: "广播协调" })).toBe(2);
      expect((await target!.call<Mail[]>("inbox")).map(mail => [mail.from, mail.to, mail.kind, mail.text])).toEqual([
        [senderId, targetId, "message", "定向协调"], [senderId, targetId, "message", "广播协调"],
      ]);
      expect((await other!.call<Mail[]>("inbox")).map(mail => mail.text)).toEqual(["广播协调"]);
      expect(await target!.call<Mail[]>("inbox")).toEqual([]);
      await sender!.call("acquire");
      await sender!.call("acquire");
      expect((await target!.call<Mail[]>("inbox")).map(mail => mail.kind)).toEqual(["request"]);
      expect(await sender!.call<boolean>("release")).toBe(true);
      expect(await sender!.call<boolean>("release")).toBe(false);
      expect((await target!.call<Mail[]>("inbox")).map(mail => mail.kind)).toEqual(["release"]);
    });
  }, 30_000);

  test("取消与过期等待撤销竞争建议，但不释放活跃额度", async () => {
    await withWorkers(3, async ([owner, cancelled, expired], directory) => {
      const ownerId = (await owner!.ready).id;
      await owner!.call("acquire", { demand: elastic });
      await cancelled!.call("acquire", { demand: elastic });
      await expired!.call("acquire", { demand: elastic });
      expect(await cancelled!.call<boolean>("cancel")).toBe(true);
      expect(await cancelled!.call<boolean>("release")).toBe(false);
      editDatabase(directory, "UPDATE requests SET refreshed_at = ? WHERE owner_id = ?", Date.now() - 120_001, (await expired!.ready).id);
      await expired!.call("heartbeat");
      const state = await owner!.call<Snapshot>("snapshot");
      expect(state.queue).toEqual([]);
      expect(state.leases[0]!.allocation.cpu).toBe(8);
      expect(state.recommendations.find(entry => entry.ownerId === ownerId)?.target?.cpu).toBe(8);
    });
  }, 30_000);

  test("存活但陈旧心跳不释放；崩溃回收额度且等待者可领取", async () => {
    await withWorkers(2, async ([owner, waiting], directory) => {
      const ownerId = (await owner!.ready).id;
      await owner!.call("acquire");
      editDatabase(directory, "UPDATE peers SET heartbeat_at = ? WHERE id = ?", 1, ownerId);
      expect((await waiting!.call<AcquireResult>("acquire")).status).toBe("queued");
      expect((await waiting!.call<Snapshot>("snapshot")).leases[0]?.ownerId).toBe(ownerId);
      await owner!.call("heartbeat");
      expect((await waiting!.call<AcquireResult>("acquire")).status).toBe("queued");
      await owner!.kill();
      expect((await waiting!.call<AcquireResult>("acquire")).status).toBe("granted");
      expect((await waiting!.call<Snapshot>("snapshot")).peers.some(peer => peer.id === ownerId)).toBe(false);
    });
  }, 30_000);

  test("关闭撤销额度和身份，下一窗仍需主动申请", async () => {
    await withWorkers(2, async ([owner, waiting]) => {
      const ownerId = (await owner!.ready).id;
      await owner!.call("acquire");
      await waiting!.call("acquire");
      await owner!.call("close");
      expect(await owner!.waitForExit()).toBe(0);
      const snapshot = await waiting!.call<Snapshot>("snapshot");
      expect(snapshot.peers.some(peer => peer.id === ownerId)).toBe(false);
      expect(snapshot.leases).toEqual([]);
      expect((await waiting!.call<AcquireResult>("acquire")).status).toBe("granted");
    });
  }, 30_000);
});

test("边界输入被拒绝且不污染资源和消息", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ompmail-validation-"));
  const coordinator = new Coordinator({ directory, capacity: { cpu: 8, memoryMB: 8192, gpu: 100 } });
  try {
    for (const reason of ["", "  ", "x".repeat(501), null, 42]) {
      expect(() => coordinator.acquire(reason as string, fixed(1))).toThrow();
    }
    for (const value of [-1, 1.5, NaN, Infinity]) {
      expect(() => coordinator.acquire("错误额度", fixed(value))).toThrow();
    }
    expect(() => coordinator.acquire("过大下限", fixed(9))).toThrow();
    expect(() => coordinator.acquire("错误范围", { minimum: fixed(2).minimum, preferred: fixed(1).preferred })).toThrow();
    expect(() => coordinator.acquire("错误GPU", fixed(1, 1, 101))).toThrow();
    expect(() => coordinator.acquire("空需求", undefined as unknown as Demand)).toThrow();
    expect(() => coordinator.acquire("错误确认", fixed(1), { cpu: 0, memoryMB: 1, gpu: 0 })).toThrow();
    expect(() => coordinator.acquire("全零下限", fixed(0, 0, 0))).toThrow();
    expect(() => coordinator.acquire("空确认", fixed(1), null as never)).toThrow();
    for (const text of ["", "  ", "x".repeat(4001), null, 42]) {
      expect(() => coordinator.send(coordinator.id, text as string)).toThrow();
    }
    expect(() => coordinator.send("不存在", "消息")).toThrow();
    expect(coordinator.snapshot().leases).toEqual([]);
    expect(coordinator.snapshot().queue).toEqual([]);
    expect(coordinator.inbox()).toEqual([]);
    expect(coordinator.acquire("x".repeat(500), fixed(1)).status).toBe("granted");
    expect(coordinator.send(coordinator.id, "x".repeat(4000))).toBe(1);
    expect(coordinator.inbox().map(mail => mail.text)).toEqual(["x".repeat(4000)]);
    coordinator.close();
    coordinator.close();
  } finally {
    coordinator.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("内存是独立准入维度，不因CPU空闲而超额承诺", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ompmail-memory-"));
  const first = new Coordinator({ directory, capacity: { cpu: 8, memoryMB: 128, gpu: 100 } });
  const second = new Coordinator({ directory });
  try {
    expect(first.acquire("内存任务A", fixed(1, 96)).allocation).toEqual({ cpu: 1, memoryMB: 96, gpu: 0 });
    expect(second.acquire("内存任务B", fixed(1, 96)).status).toBe("queued");
    expect(second.snapshot().leases.reduce((sum, lease) => sum + lease.allocation.memoryMB, 0)).toBe(96);
    first.release();
    expect(second.acquire("内存任务B", fixed(1, 96)).allocation?.memoryMB).toBe(96);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("旧协议有活窗口时拒绝升级，全部退出后才迁移", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ompmail-migration-"));
  const db = new Database(join(directory, "state.sqlite"));
  try {
    db.exec(`CREATE TABLE peers(id TEXT PRIMARY KEY, pid INTEGER NOT NULL, label TEXT, cwd TEXT, started_at INTEGER, heartbeat_at INTEGER);
      CREATE TABLE lease(slot INTEGER PRIMARY KEY, owner_id TEXT, reason TEXT, acquired_at INTEGER);
      CREATE TABLE requests(sequence INTEGER PRIMARY KEY, owner_id TEXT, reason TEXT, requested_at INTEGER, refreshed_at INTEGER);
      CREATE TABLE mail(id INTEGER PRIMARY KEY, sender_id TEXT, recipient_id TEXT, kind TEXT, text TEXT, created_at INTEGER);
      PRAGMA user_version = 1;`);
    db.query("INSERT INTO peers VALUES ('old', ?, 'old', '.', 1, 1)").run(process.pid);
    expect(() => new Coordinator({ directory })).toThrow();
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    db.exec("DELETE FROM peers");
    const migrated = new Coordinator({ directory });
    try {
      expect(migrated.acquire("升级后", fixed(1)).status).toBe("granted");
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    } finally { migrated.close(); }
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
