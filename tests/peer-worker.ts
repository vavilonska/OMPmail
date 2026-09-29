import { createInterface } from "node:readline";
import { Coordinator } from "../src/coordinator.ts";

// This fixture is started explicitly, not discovered as a bun:test file.
const directory = process.argv[2];
if (!directory) throw new Error("缺少测试数据库目录");
const coordinator = new Coordinator({ directory, label: `worker-${process.pid}` });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const reply = (value: unknown): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  process.stdout.write(`${JSON.stringify(value)}\n`, error => {
    if (error) reject(error);
    else resolve();
  });
  return promise;
};

try {
  coordinator.start();
  await reply({ sequence: 0, value: { id: coordinator.id, pid: process.pid } });
  for await (const line of input) {
    const request = JSON.parse(line) as { sequence: number; action: string; reason?: string; to?: string; text?: string };
    try {
      let value: unknown;
      switch (request.action) {
        case "snapshot": value = coordinator.snapshot(); break;
        case "acquire": value = coordinator.acquire(request.reason ?? "测试任务"); break;
        case "release": value = coordinator.release(); break;
        case "cancel": value = coordinator.cancel(); break;
        case "send": value = coordinator.send(request.to ?? "*", request.text ?? "测试消息"); break;
        case "inbox": value = coordinator.inbox(); break;
        case "heartbeat": coordinator.heartbeat(); value = null; break;
        case "close": coordinator.close(); value = null; break;
        default: throw new Error(`未知测试操作: ${request.action}`);
      }
      await reply({ sequence: request.sequence, value });
      if (request.action === "close") break;
    } catch (error) {
      await reply({ sequence: request.sequence, error: error instanceof Error ? error.message : String(error) });
    }
  }
} finally {
  // Breaking the iterator closes readline, but does not release its owned pipe.
  input.close();
  process.stdin.pause();
  process.stdin.destroy();
  coordinator.close();
}
