import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/index.ts';
import { Coordinator } from '../src/coordinator.ts';
import type { Context, Host, Params, ToolResult } from '../src/host.ts';
import { isHeavyCommand, isHeavyTool, permitBlock } from '../src/policy.ts';
import type { Snapshot } from '../src/protocol.ts';

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

test('only the actual permit owner passes; being queue head is insufficient', () => {
  const state: Snapshot = { selfId: 'self', peers: [], lease: null,
    queue: [{ ownerId: 'self', reason: 'tests', requestedAt: 1 }] };
  expect(permitBlock(state)).toContain('acquire');
  state.lease = { ownerId: 'other', reason: 'build', acquiredAt: 1 };
  expect(permitBlock(state)).toContain('other');
  state.lease.ownerId = 'self';
  expect(permitBlock(state)).toBeUndefined();
});

// Minimal host driver; lifecycle assertions exercise the real SQLite coordinator.
function harness(kind: 'main' | 'sub') {
  const callbacks = new Map<string, unknown>();
  // The lifecycle scenario does not advance background time.
  const timers = new Map<NodeJS.Timeout, () => void>();
  let tool: Parameters<Host['registerTool']>[0] | undefined;
  const schema = { optional() { return this; }, describe(_text: string) { return this; } };
  const ctx: Context = {
    cwd: process.cwd(), agent: { kind, id: kind, name: kind, depth: kind === 'sub' ? 1 : 0 },
    ui: { notify() {}, setStatus() {} },
    setInterval(callback) {
      const handle = {} as NodeJS.Timeout;
      timers.set(handle, callback);
      return handle;
    },
    clearTimer(timer) { timers.delete(timer); },
  };
  const pi: Host = {
    zod: { string: () => schema, enum: () => schema, object: shape => shape },
    registerTool(definition) { tool = definition; },
    registerCommand() {},
    on(name, callback) { callbacks.set(name, callback); },
    sendMessage() {},
  };
  extension(pi);
  return {
    async event(name: string, event: unknown = {}) {
      const callback = callbacks.get(name) as ((event: unknown, ctx: Context) => unknown);
      return await callback(event, ctx);
    },
    async action(params: Params, signal?: AbortSignal): Promise<ToolResult> {
      return tool!.execute('test', params, signal, undefined, ctx);
    },
  };
}

test('rebound children share one peer and cannot release the main permit; final shutdown releases it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ompmail-extension-'));
  const previous = process.env.OMPMAIL_DIR;
  process.env.OMPMAIL_DIR = directory;
  const observer = new Coordinator({ directory, label: 'observer' });
  const main = harness('main');
  const child = harness('sub');
  try {
    observer.start();
    await main.event('session_start');
    await child.event('session_start');
    expect(observer.snapshot().peers.length).toBe(2);
    const blocked = await child.event('tool_call', { toolName: 'bash', input: { command: 'bun test' } });
    expect(blocked).toMatchObject({ block: true });
    expect(await main.event('tool_call', { toolName: 'bash', input: { command: 'git status' } })).toBeUndefined();
    const abort = new AbortController();
    abort.abort();
    expect((await main.action({ action: 'acquire', reason: 'aborted' }, abort.signal)).isError).toBe(true);
    expect(observer.snapshot().lease).toBeNull();
    expect(observer.snapshot().queue).toEqual([]);
    expect((await main.action({ action: 'acquire', reason: 'test shared lifetime' })).details).toMatchObject({ status: 'granted' });
    expect(await child.event('tool_call', { toolName: 'bash', input: { command: 'bun test' } })).toBeUndefined();
    const owner = observer.snapshot().lease!.ownerId;
    expect((await child.action({ action: 'release' })).isError).toBe(true);
    expect((await child.action({ action: 'cancel' })).isError).toBe(true);
    expect(observer.snapshot().lease!.ownerId).toBe(owner);
    await main.event('session_shutdown');
    expect(observer.snapshot().lease!.ownerId).toBe(owner);
    await child.event('session_shutdown');
    expect(observer.snapshot().lease).toBeNull();
    expect(observer.snapshot().peers.map(peer => peer.id)).toEqual([observer.id]);
  } finally {
    await main.event('session_shutdown');
    await child.event('session_shutdown');
    observer.close();
    if (previous === undefined) delete process.env.OMPMAIL_DIR;
    else process.env.OMPMAIL_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
