import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator } from "../src/coordinator.ts";
import type { AcquireResult, Mail, Snapshot } from "../src/protocol.ts";

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

  async call<T>(action: string, fields: Record<string, string> = {}): Promise<T> {
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

describe("真实进程的窗口协调", () => {
  test("并发首次启动和申请只有一个持有者，等待者按真实入队顺序获得许可", async () => {
    await withWorkers(4, async workers => {
      const identities = await Promise.all(workers.map(worker => worker.ready));
      const results = await Promise.all(workers.map(worker => worker.call<AcquireResult>("acquire")));
      expect(results.filter(result => result.status === "granted").length).toBe(1);
      expect(results.filter(result => result.status === "queued").length).toBe(3);
      const snapshot = await workers[0]!.call<Snapshot>("snapshot");
      expect(new Set(snapshot.peers.map(peer => peer.pid)).size).toBe(4);
      expect(snapshot.queue.map(request => request.ownerId).sort()).toEqual(
        results.filter(result => result.status === "queued").map(result => result.ownerId).sort(),
      );
      const byId = new Map(identities.map((identity, index) => [identity.id, workers[index]!]));
      let owner = byId.get(snapshot.lease!.ownerId)!;
      const reentrant = await owner.call<AcquireResult>("acquire", { reason: "重复申请" });
      expect(reentrant.status).toBe("granted");
      expect(reentrant.position).toBe(0);
      for (let index = 0; index < snapshot.queue.length; index++) {
        expect(await owner.call<boolean>("release")).toBe(true);
        const nextId = snapshot.queue[index]!.ownerId;
        const afterRelease = await workers[0]!.call<Snapshot>("snapshot");
        expect(afterRelease.lease).toBeNull();
        // A younger waiter cannot jump the queue, even when the lease is empty.
        for (const later of snapshot.queue.slice(index + 1)) {
          expect((await byId.get(later.ownerId)!.call<AcquireResult>("acquire")).status).toBe("queued");
        }
        owner = byId.get(nextId)!;
        const granted = await owner.call<AcquireResult>("acquire");
        expect(granted.status).toBe("granted");
        expect(granted.lease?.ownerId).toBe(nextId);
      }
      expect((await owner.call<Snapshot>("snapshot")).queue).toEqual([]);
    });
  }, 30_000);

  test("定向和广播只读一次，申请通知不因刷新重复，释放通知可见", async () => {
    await withWorkers(3, async ([sender, target, other]) => {
      const senderId = (await sender!.ready).id;
      const targetId = (await target!.ready).id;
      expect(await sender!.call<number>("send", { to: targetId, text: "定向协调" })).toBe(1);
      expect(await sender!.call<number>("send", { to: "*", text: "广播协调" })).toBe(2);
      expect((await target!.call<Mail[]>("inbox")).map(mail => [mail.from, mail.to, mail.kind, mail.text])).toEqual([
        [senderId, targetId, "message", "定向协调"],
        [senderId, targetId, "message", "广播协调"],
      ]);
      expect((await other!.call<Mail[]>("inbox")).map(mail => mail.text)).toEqual(["广播协调"]);
      expect(await target!.call<Mail[]>("inbox")).toEqual([]);
      expect(await sender!.call<Mail[]>("inbox")).toEqual([]);
      await sender!.call("acquire");
      await sender!.call("acquire");
      expect((await target!.call<Mail[]>("inbox")).map(mail => mail.kind)).toEqual(["request"]);
      expect(await sender!.call<boolean>("release")).toBe(true);
      expect(await sender!.call<boolean>("release")).toBe(false);
      expect((await target!.call<Mail[]>("inbox")).map(mail => mail.kind)).toEqual(["release"]);
    });
  }, 30_000);

  test("取消等待不释放别人的许可，释放后下一位仍须主动申请", async () => {
    await withWorkers(3, async ([owner, cancelled, next]) => {
      await owner!.call("acquire");
      expect((await cancelled!.call<AcquireResult>("acquire")).position).toBe(1);
      expect((await next!.call<AcquireResult>("acquire")).position).toBe(2);
      expect(await cancelled!.call<boolean>("cancel")).toBe(true);
      expect(await cancelled!.call<boolean>("cancel")).toBe(false);
      expect(await cancelled!.call<boolean>("release")).toBe(false);
      expect((await next!.call<AcquireResult>("acquire")).position).toBe(1);
      await owner!.call("release");
      expect((await next!.call<Snapshot>("snapshot")).lease).toBeNull();
      expect((await next!.call<AcquireResult>("acquire")).status).toBe("granted");
    });
  }, 30_000);

  test("崩溃持有者被回收，已退出窗口不再出现在发现列表", async () => {
    await withWorkers(2, async ([owner, waiting]) => {
      const ownerId = (await owner!.ready).id;
      await owner!.call("acquire");
      expect((await waiting!.call<AcquireResult>("acquire")).status).toBe("queued");
      await owner!.kill();
      expect((await waiting!.call<AcquireResult>("acquire")).status).toBe("granted");
      expect((await waiting!.call<Snapshot>("snapshot")).peers.some(peer => peer.id === ownerId)).toBe(false);
    });
  }, 30_000);

  test("存活窗口的过期心跳不会释放许可，普通心跳也不释放", async () => {
    await withWorkers(2, async ([owner, waiting], directory) => {
      const ownerId = (await owner!.ready).id;
      await owner!.call("acquire");
      editDatabase(directory, "UPDATE peers SET heartbeat_at = ? WHERE id = ?", 1, ownerId);
      const stale = await waiting!.call<Snapshot>("snapshot");
      expect(stale.peers.find(peer => peer.id === ownerId)?.heartbeatAt).toBe(1);
      expect(stale.lease?.ownerId).toBe(ownerId);
      expect((await waiting!.call<AcquireResult>("acquire")).status).toBe("queued");
      await owner!.call("heartbeat");
      expect((await waiting!.call<Snapshot>("snapshot")).lease?.ownerId).toBe(ownerId);
    });
  }, 30_000);

  test("等待请求超过120秒未重新申请则过期，即使其进程仍活着且有心跳", async () => {
    await withWorkers(3, async ([owner, abandoned, next], directory) => {
      const abandonedId = (await abandoned!.ready).id;
      await owner!.call("acquire");
      await abandoned!.call("acquire");
      await next!.call("acquire");
      editDatabase(directory, "UPDATE requests SET refreshed_at = ? WHERE owner_id = ?", Date.now() - 120_001, abandonedId);
      await abandoned!.call("heartbeat");
      await owner!.call("release");
      const result = await next!.call<AcquireResult>("acquire");
      expect(result.status).toBe("granted");
      expect((await next!.call<Snapshot>("snapshot")).queue).toEqual([]);
    });
  }, 30_000);

  test("关闭撤销自己的等待或许可，重复关闭安全", async () => {
    await withWorkers(2, async ([owner, waiting]) => {
      const ownerId = (await owner!.ready).id;
      await owner!.call("acquire");
      await waiting!.call("acquire");
      await owner!.call("close");
      expect(await owner!.waitForExit()).toBe(0);
      const snapshot = await waiting!.call<Snapshot>("snapshot");
      expect(snapshot.peers.some(peer => peer.id === ownerId)).toBe(false);
      expect(snapshot.lease).toBeNull();
      expect((await waiting!.call<AcquireResult>("acquire")).status).toBe("granted");
    });
  }, 30_000);

  test("拒绝未知收件人、空白和超长或非字符串载荷，不污染许可及消息", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ompmail-validation-"));
    let coordinator: Coordinator | undefined;
    try {
      expect(() => {
        const invalid = new Coordinator({ directory, label: "x".repeat(121) });
        try { invalid.start(); } finally { invalid.close(); }
      }).toThrow();
      coordinator = new Coordinator({ directory, label: "验证窗口" });
      coordinator.start();
      coordinator.start();
      for (const reason of ["", "  ", "x".repeat(501), null, 42]) {
        expect(() => coordinator!.acquire(reason as string)).toThrow();
      }
      for (const text of ["", "  ", "x".repeat(4001), null, 42]) {
        expect(() => coordinator!.send(coordinator!.id, text as string)).toThrow();
      }
      expect(() => coordinator!.send("不存在的窗口", "消息")).toThrow();
      expect(coordinator.snapshot().lease).toBeNull();
      expect(coordinator.snapshot().queue).toEqual([]);
      expect(coordinator.inbox()).toEqual([]);
      expect(coordinator.acquire("x".repeat(500)).status).toBe("granted");
      expect(coordinator.send(coordinator.id, "x".repeat(4000))).toBe(1);
      expect(coordinator.inbox().map(mail => mail.text)).toEqual(["x".repeat(4000)]);
      coordinator.close();
      coordinator.close();
    } finally {
      coordinator?.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
