import type { Snapshot } from './protocol.ts';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

// Small shell lexer: quoted arguments stay intact, so echo/grep text is not a command.
// This is deliberately not a shell interpreter or an arbitrary-script resource detector.
function segments(command: string): string[][] {
  const result: string[][] = [];
  let words: string[] = [], word = '', quote = '';
  const flushWord = () => { if (word) words.push(word); word = ''; };
  const flush = () => { flushWord(); if (words.length) result.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && command[i + 1] === quote) word += command[++i];
      else word += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (';&|\n()'.includes(char)) flush();
    else if (/\s/.test(char)) flushWord();
    else if (char === '#' && !word) { while (i < command.length && command[i] !== '\n') i++; flush(); }
    else word += char;
  }
  flush();
  return result;
}

const heavyAction = /^(?:build|test|check|compile|train|training|render|bench|benchmark|lint|typecheck)(?:[:._-]|$)/i;
const directHeavy = /^(?:make|gmake|ninja|msbuild|gcc|g\+\+|clang|clang\+\+|rustc|tsc|pytest|jest|vitest|mocha|ffmpeg|blender|torchrun|accelerate)$/i;
function executable(token: string): string {
  return token.replace(/\\/g, '/').split('/').pop()!.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}
function heavySegment(tokens: string[], depth: number): boolean {
  let offset = 0;
  while (/^[A-Za-z_][\w]*=/.test(tokens[offset] ?? '')) offset++;
  const name = executable(tokens[offset] ?? '');
  const args = tokens.slice(offset + 1);
  if (!name) return false;
  if (['env', 'sudo', 'nohup', 'time', 'command', 'exec', 'call'].includes(name)) {
    const first = args.findIndex(arg => !arg.startsWith('-') && !/^[A-Za-z_]\w*=/.test(arg));
    return first >= 0 && heavySegment(args.slice(first), depth);
  }
  if (['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh'].includes(name)) {
    const index = args.findIndex(arg => /^(-[a-z]*c|\/c|-command)$/i.test(arg));
    return index >= 0 && isHeavyCommand(args.slice(index + 1).join(' '), depth + 1);
  }
  if (args.some(arg => /^(--help|--version|-h)$/.test(arg))) return false;
  if (directHeavy.test(name)) return true;
  if (['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'dotnet', 'go', 'gradle', 'gradlew', 'mvn', 'cmake', 'docker'].includes(name)) {
    return args.some(arg => heavyAction.test(arg)
      || (['cargo', 'dotnet', 'go'].includes(name) && arg === 'run')
      || (name === 'cmake' && arg === '--build')
      || (name === 'mvn' && /^(package|verify|install)$/.test(arg))
      || (args.includes('exec') && directHeavy.test(executable(arg))));
  }
  if (name === 'npx' || name === 'bunx' || name === 'uv') return args.some(arg => directHeavy.test(executable(arg)) || heavyAction.test(arg));
  if (/^(python[\d.]*|node|ruby)$/.test(name)) {
    return args.some(arg => /^(?:pytest|unittest|compileall)$/.test(arg) || heavyAction.test(executable(arg)));
  }
  return name !== 'test' && heavyAction.test(name);
}
export function isHeavyCommand(command: string, depth = 0): boolean {
  if (depth > 8) return true;
  return segments(command).some(tokens => heavySegment(tokens, depth));
}

/** Inspect actual bash calls and the documented parallel wrapper's nested calls. */
export function isHeavyTool(toolName: string, input: unknown, depth = 0): boolean {
  const value = record(input);
  if (!value) return false;
  if (toolName === 'bash' || toolName === 'functions.bash') {
    return typeof value.command === 'string' && isHeavyCommand(value.command);
  }
  if ((toolName === 'multi_tool_use.parallel' || toolName === 'parallel') && Array.isArray(value.tool_uses)) {
    if (depth > 8) return true;
    return value.tool_uses.some(item => {
      const call = record(item);
      return typeof call?.recipient_name === 'string' && isHeavyTool(call.recipient_name, call.parameters, depth + 1);
    });
  }
  return false;
}

export function permitBlock(snapshot: Snapshot): string | undefined {
  if (snapshot.lease?.ownerId === snapshot.selfId) return undefined;
  const position = snapshot.queue.findIndex(request => request.ownerId === snapshot.selfId) + 1;
  return `OMPmail：高资源任务未获许可。请先调用 ompmail(action="acquire", reason="具体任务") 或 /ompmail acquire <原因>，仅在 granted 后执行。持有者：${snapshot.lease?.ownerId ?? '无'}；本窗口排队位置：${position || '未排队'}。排队时可做低资源工作；120 秒内再次 acquire 可保留排队资格。所有异步任务和子代理重任务结束后，由主会话显式 release。`;
}
