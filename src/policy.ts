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
  if (snapshot.leases.some(lease => lease.ownerId === snapshot.selfId)) return undefined;
  const waiting = snapshot.queue.some(request => request.ownerId === snapshot.selfId);
  return `OMPmail：本窗口没有实际资源授权，高资源任务已阻止。由主会话调用 acquire，提供 reason 和 demand={minimum:{cpu,memoryMB,gpu},preferred:{cpu,memoryMB,gpu}}，仅 granted 后按实际 allocation 执行；建议 target 或等待状态不是许可。当前 ${snapshot.leases.length} 个窗口持有额度，本窗口${waiting ? '正在等待，120 秒内重试保留资格' : '未申请'}。子代理须通知主会话申请；所有子代理及后台重任务结束后由主会话 release。`;
}
