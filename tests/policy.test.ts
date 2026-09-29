import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/index.ts';
import { Coordinator } from '../src/coordinator.ts';
import type { CommandCompletion, Context, CustomMessage, Host, Params, ToolResult } from '../src/host.ts';
import { isHeavyCommand, isHeavyTool, permitBlock } from '../src/policy.ts';
import type { Demand, Resources, Snapshot } from '../src/protocol.ts';

describe('common heavy command recognition', () => {
  test.each([
    'bun test', 'npm run build', 'pnpm --filter app test:unit', 'cargo test --release',
    'cargo run --release', 'dotnet build', 'go test ./...', 'cmake --build out',
    'npx tsc --noEmit', 'npm exec tsc', 'uv run pytest', 'python -m pytest tests',
    'python train_model.py', 'node scripts/render.js', 'ffmpeg -i input.mp4 out.webm',
    'cd project && npm run build', 'CI=1 bun test', 'env CI=1 pytest',
    'bash -lc "bun test"', 'cmd /c "npm run build"',
    '"C:\\Program Files\\nodejs\\npm.cmd" run build',
    'echo ready; make -j8', 'cat log | grep done; ./train.sh',
  ])('recognizes %s', command => { expect(isHeavyCommand(command)).toBe(true); });

  test.each([
    'echo "npm run build; pytest"', 'printf "%s" "ffmpeg"', 'cat build.log',
    'grep test package.json', 'git status', 'git show HEAD:test.ts', 'ls tests',
    'test -f package.json', '[ -e build ]', 'npm --version', 'ffmpeg --help',
    'python -c "print(123)"', 'node custom.js', '# bun test\necho ready',
  ])('does not block light work %s', command => { expect(isHeavyCommand(command)).toBe(false); });

  test('checks nested bash calls, not arbitrary text in unrelated tools', () => {
    expect(isHeavyTool('multi_tool_use.parallel', { tool_uses: [
      { recipient_name: 'functions.read', parameters: { path: 'build.ts' } },
      { recipient_name: 'functions.bash', parameters: { command: 'bun test' } },
    ] })).toBe(true);
    expect(isHeavyTool('functions.bash', { command: 'git diff' })).toBe(false);
    expect(isHeavyTool('write', { content: 'bun test' })).toBe(false);
    expect(isHeavyTool('eval', { code: 'arbitraryProgram()' })).toBe(false);
  });
});

const minimum: Resources = { cpu: 1, memoryMB: 1, gpu: 0 };
const demand: Demand = { minimum, preferred: { ...minimum, gpu: 100 } };
const competitorDemand: Demand = { minimum: { ...minimum, gpu: 50 }, preferred: { ...minimum, gpu: 50 } };

test('only an actual local grant passes, not a recommendation or waiting request', () => {
  const state: Snapshot = { selfId: 'self', peers: [], capacity: { cpu: 8, memoryMB: 8192, gpu: 100 }, freeMemoryMB: 8192,
    leases: [], queue: [{ ownerId: 'self', reason: 'tests', requestedAt: 1, demand }],
    recommendations: [{ ownerId: 'self', target: demand.preferred }] };
  expect(permitBlock(state)).toBeDefined();
  state.leases.push({ ownerId: 'other', reason: 'build', acquiredAt: 1, demand, allocation: demand.preferred });
  expect(permitBlock(state)).toBeDefined();
  state.leases.push({ ownerId: 'self', reason: 'tests', acquiredAt: 1, demand, allocation: minimum });
  expect(permitBlock(state)).toBeUndefined();
  state.leases.pop();
  expect(permitBlock(state)).toBeDefined();
});

interface Harness {
  messages: { message: CustomMessage; options: { triggerTurn: false; deliverAs: 'nextTurn' } }[];
  notifications: string[];
  statuses: (string | undefined)[];
  timers: Map<NodeJS.Timeout, () => void>;
  poll(): void;
  command(args: string): Promise<void>;
  complete(prefix: string): CommandCompletion[] | null;
  event(name: string, event?: unknown): Promise<unknown>;
  action(params: Params, signal?: AbortSignal): Promise<ToolResult>;
}

// Minimal host driver; lifecycle assertions exercise the real SQLite coordinator.
function harness(kind: 'main' | 'sub'): Harness {
  const callbacks = new Map<string, unknown>();
  const messages: { message: CustomMessage; options: { triggerTurn: false; deliverAs: 'nextTurn' } }[] = [];
  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];
  let command: Parameters<Host['registerCommand']>[1] | undefined;
  const timers = new Map<NodeJS.Timeout, () => void>();
  let tool: Parameters<Host['registerTool']>[0] | undefined;
  const schema = { optional() { return this; }, describe(_text: string) { return this; } };
  const ctx: Context = {
    cwd: process.cwd(), agent: { kind, id: kind, name: kind, depth: kind === 'sub' ? 1 : 0 },
    ui: { notify(message) { notifications.push(message); }, setStatus(_key, text) { statuses.push(text); } },
    setInterval(callback) {
      const handle = {} as NodeJS.Timeout;
      timers.set(handle, callback);
      return handle;
    },
    clearTimer(timer) { timers.delete(timer); },
  };
  const pi: Host = {
    zod: { string: () => schema, number: () => schema, enum: () => schema, object: () => schema },
    registerTool(definition) { tool = definition; },
    registerCommand(_name, definition) { command = definition; },
    on(name, callback) { callbacks.set(name, callback); },
    sendMessage(message, options) { messages.push({ message, options }); },
  };
  extension(pi);
  return {
    messages, notifications, statuses, timers,
    poll() { for (const callback of [...timers.values()]) callback(); },
    async command(args: string) { await command!.handler(args, ctx); },
    complete(prefix) { return command!.getArgumentCompletions!(prefix); },
    async event(name: string, event: unknown = {}) {
      const callback = callbacks.get(name) as ((event: unknown, ctx: Context) => unknown);
      return await callback(event, ctx);
    },
    async action(params: Params, signal?: AbortSignal): Promise<ToolResult> {
      return tool!.execute('test', params, signal, undefined, ctx);
    },
  };
}

async function scenario(run: (main: Harness, observer: Coordinator, directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'ompmail-extension-'));
  const previous = process.env.OMPMAIL_DIR;
  process.env.OMPMAIL_DIR = directory;
  const observer = new Coordinator({ directory, label: 'observer', capacity: { cpu: 8, memoryMB: 8192, gpu: 100 } });
  const main = harness('main');
  try {
    observer.start();
    await main.event('session_start');
    await run(main, observer, directory);
  } finally {
    await main.event('session_shutdown');
    observer.close();
    if (previous === undefined) delete process.env.OMPMAIL_DIR;
    else process.env.OMPMAIL_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

test('multiple main clients and children share lifetime and only mains adjust the grant', async () => {
  await scenario(async (main, observer) => {
    const secondMain = harness('main');
    const child = harness('sub');
    try {
      await secondMain.event('session_start');
      await child.event('session_start');
      expect(observer.snapshot().peers.map(peer => peer.id).length).toBe(2);
      expect(await child.event('tool_call', { toolName: 'bash', input: { command: 'bun test' } })).toMatchObject({ block: true });
      expect(await main.event('tool_call', { toolName: 'bash', input: { command: 'git status' } })).toBeUndefined();
      const abort = new AbortController();
      abort.abort();
      expect((await main.action({ action: 'acquire', reason: 'aborted', demand }, abort.signal)).isError).toBe(true);
      expect((await main.action({ action: 'acquire', reason: 'missing demand' })).isError).toBe(true);
      expect(observer.snapshot().leases).toEqual([]);
      expect(observer.snapshot().queue).toEqual([]);
      expect((await main.action({ action: 'acquire', reason: 'shared lifetime', demand })).details).toMatchObject({ status: 'granted', updated: true });
      expect(await child.event('tool_call', { toolName: 'bash', input: { command: 'bun test' } })).toBeUndefined();
      const grant = observer.snapshot().leases[0]!;
      for (const action of ['acquire', 'wait', 'release', 'cancel'] as const) {
        expect((await child.action({ action, reason: 'child adjustment', demand, allocation: minimum })).isError).toBe(true);
        expect(observer.snapshot().leases).toEqual([grant]);
      }
      await main.event('session_shutdown');
      expect(secondMain.timers.size).toBe(1);
      expect(observer.snapshot().leases).toEqual([grant]);
      expect((await secondMain.action({ action: 'acquire', reason: 'retained demand' })).isError).toBeUndefined();
      await secondMain.event('session_shutdown');
      expect(child.timers.size).toBe(1);
      expect(observer.snapshot().leases[0]!.ownerId).toBe(grant.ownerId);
      await child.event('session_shutdown');
      expect(observer.snapshot().leases).toEqual([]);
      expect(observer.snapshot().peers.map(peer => peer.id)).toEqual([observer.id]);
    } finally {
      await secondMain.event('session_shutdown');
      await child.event('session_shutdown');
    }
  });
});

test('command acquire requires a JSON object and malformed requests never create a grant', async () => {
  await scenario(async (main, observer) => {
    for (const input of ['wait', 'acquire build tests', 'acquire []', 'acquire null', 'acquire {"reason":"missing"}',
      'acquire {"reason":"invalid","demand":{"minimum":{},"preferred":{}}}']) {
      await main.command(input);
      expect(observer.snapshot().leases).toEqual([]);
      expect(observer.snapshot().queue).toEqual([]);
      const message = main.messages.at(-1)!.message.content;
      expect(JSON.parse(message.slice(message.indexOf('\n') + 1))).toHaveProperty('error');
    }
    await main.command(`acquire ${JSON.stringify({ reason: 'command task', demand })}`);
    expect(observer.snapshot().leases[0]!.allocation).toEqual(demand.preferred);
    await main.command('status');
    expect(observer.snapshot().leases[0]!.allocation).toEqual(demand.preferred);
  });
});

test('failed growth retains the old allocation and does not turn a target into permission', async () => {
  await scenario(async (main, observer) => {
    await main.action({ action: 'acquire', reason: 'main task', demand });
    observer.acquire('competing task', competitorDemand);
    const reduced = { ...minimum, gpu: 50 };
    expect((await main.action({ action: 'acquire', reason: 'actually reduced', allocation: reduced })).details)
      .toMatchObject({ status: 'granted', updated: true, allocation: reduced });
    expect(observer.acquire('competing task', competitorDemand).status).toBe('granted');
    const response = await main.action({ action: 'acquire', reason: 'growth not available', allocation: demand.preferred });
    expect(response.details).toMatchObject({ status: 'granted', updated: false, allocation: reduced });
    const snapshot = (await main.action({ action: 'status' })).details as Snapshot;
    expect(snapshot.leases.find(lease => lease.ownerId === snapshot.selfId)!.allocation).toEqual(reduced);
    expect(await main.event('tool_call', { toolName: 'bash', input: { command: 'bun test' } })).toBeUndefined();
    observer.release();
    expect((await main.action({ action: 'acquire', reason: 'alone again' })).details)
      .toMatchObject({ status: 'granted', updated: true, allocation: demand.preferred });
  });
});

test.each(['cancel', 'release', 'expiry', 'crash'] as const)('heartbeat reports changed targets once after %s, without automatic turns', async removal => {
  await scenario(async (main, observer, directory) => {
    await main.action({ action: 'acquire', reason: 'main task', demand });
    main.poll();
    const resourceMessages = () => main.messages.filter(item => item.message.customType === 'ompmail-resources');
    const initial = resourceMessages().length;
    observer.acquire('competitor', competitorDemand);
    main.poll();
    expect(resourceMessages().length).toBe(initial + 1);
    const changed = resourceMessages().at(-1)!;
    const payload = JSON.parse(changed.message.content.slice(changed.message.content.indexOf('\n') + 1));
    expect(payload.target).toEqual({ ...minimum, gpu: 50 });
    expect(payload.allocation).toEqual(demand.preferred);
    expect(changed.options).toEqual({ triggerTurn: false, deliverAs: 'nextTurn' });
    const notifications = main.notifications.length;
    main.poll();
    main.poll();
    expect(resourceMessages().length).toBe(initial + 1);
    expect(main.notifications.length).toBe(notifications);
    if (removal === 'release') {
      await main.action({ action: 'acquire', reason: 'reduced at boundary', allocation: { ...minimum, gpu: 50 } });
      observer.acquire('competitor', competitorDemand);
      observer.release();
    } else if (removal === 'cancel') observer.cancel();
    else {
      const db = new Database(join(directory, 'state.sqlite'));
      try {
        if (removal === 'expiry') db.query('UPDATE requests SET refreshed_at = 0 WHERE owner_id = ?').run(observer.id);
        else db.query('UPDATE peers SET pid = 2147483647 WHERE id = ?').run(observer.id);
      } finally { db.close(); }
    }
    main.poll();
    expect(resourceMessages().length).toBe(initial + 2);
    const restored = resourceMessages().at(-1)!;
    expect(JSON.parse(restored.message.content.slice(restored.message.content.indexOf('\n') + 1)).target).toEqual(demand.preferred);
    const afterRemoval = main.notifications.length;
    main.poll();
    expect(resourceMessages().length).toBe(initial + 2);
    expect(main.notifications.length).toBe(afterRemoval);
  });
});

test('resource wait acquires after contention ends without a generic job wait or automatic model turn', async () => {
  await scenario(async (main, observer) => {
    observer.acquire('blocking task', demand);
    expect((await main.action({ action: 'acquire', reason: 'waiting task', demand: competitorDemand })).details)
      .toMatchObject({ status: 'queued', allocation: null });
    const waiting = main.action({ action: 'wait' });
    observer.release();
    const response = await waiting;
    expect(response.details).toMatchObject({ status: 'granted', updated: true, allocation: competitorDemand.preferred });
    expect(observer.snapshot().queue).toEqual([]);
    expect(main.messages).toEqual([]);
    expect(await main.event('tool_call', { toolName: 'bash', input: { command: 'bun test' } })).toBeUndefined();
    expect((await main.action({ action: 'wait' })).isError).toBe(true);
  });
});

test('aborting resource wait promptly preserves the pending request and other allocations', async () => {
  await scenario(async (main, observer) => {
    observer.acquire('blocking task', demand);
    await main.action({ action: 'acquire', reason: 'waiting task', demand: competitorDemand });
    const before = observer.snapshot();
    const abort = new AbortController();
    const waiting = main.action({ action: 'wait' }, abort.signal);
    abort.abort();
    expect((await waiting).details).toMatchObject({ cancelled: true });
    expect(observer.snapshot().leases).toEqual(before.leases);
    expect(observer.snapshot().queue).toEqual(before.queue);
  });
});

test.each(['cancel', 'expiry', 'shutdown'] as const)('resource wait never rebuilds a request removed by %s', async removal => {
  await scenario(async (main, observer, directory) => {
    expect((await main.action({ action: 'wait' })).isError).toBe(true);
    observer.acquire('blocking task', demand);
    await main.action({ action: 'acquire', reason: 'waiting task', demand: competitorDemand });
    const ownerId = observer.snapshot().queue[0]!.ownerId;
    const waiting = main.action({ action: 'wait' });
    if (removal === 'cancel') await main.action({ action: 'cancel' });
    else if (removal === 'shutdown') await main.event('session_shutdown');
    else {
      const db = new Database(join(directory, 'state.sqlite'));
      try { db.query('UPDATE requests SET refreshed_at = 0 WHERE owner_id = ?').run(ownerId); }
      finally { db.close(); }
    }
    observer.release();
    expect((await waiting).details).toMatchObject({ cancelled: true });
    expect(observer.snapshot().queue).toEqual([]);
    expect(observer.snapshot().leases).toEqual([]);
  });
});

test('completion filters prefixes, sends to the selected peer, and leaves free text untouched', async () => {
  await scenario(async (main, observer) => {
    const send = main.complete('se')!;
    expect(send.map(item => item.value)).toEqual(['send']);
    const recipient = main.complete(`send ${observer.id.slice(0, 8)}`)![0]!;
    await main.command(`${recipient.value} 从补全选中的窗口发送`);
    expect(observer.inbox().map(mail => [mail.to, mail.text])).toEqual([[observer.id, '从补全选中的窗口发送']]);
    expect(main.complete(`send ${observer.id} 任意消息`)).toBeNull();
    expect(main.complete('acquire {"reason":')).toBeNull();
    expect(main.complete('does-not-exist')).toBeNull();
    expect(main.complete('send ')!.map(item => item.value)).toEqual(['send *', `send ${observer.id}`]);
    observer.close();
    main.poll();
    expect(main.complete('send ')!.map(item => item.value)).toEqual(['send *']);
  });
});
