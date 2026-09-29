import type { Demand, Resources } from './protocol.ts';

export type Action = 'status' | 'acquire' | 'wait' | 'release' | 'cancel' | 'send' | 'inbox';
export interface Params { action: Action; reason?: string; demand?: Demand; allocation?: Resources; to?: string; text?: string }
export interface CommandCompletion { value: string; label: string; description?: string }
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  details: unknown;
  isError?: boolean;
}
interface Schema {
  optional(): Schema;
  describe(text: string): Schema;
}
export interface Context {
  cwd: string;
  agent: { kind: 'main' | 'sub'; id: string; name: string; depth: number };
  ui: {
    notify(message: string, level?: 'info' | 'warning' | 'error'): void;
    setStatus(key: string, text: string | undefined): void;
  };
  setInterval(callback: () => void, milliseconds: number): NodeJS.Timeout;
  clearTimer(timer: NodeJS.Timeout): void;
}
export interface CustomMessage {
  customType: string;
  content: string;
  display: boolean;
  attribution: 'agent';
}
interface Events {
  session_start: { type: 'session_start' };
  session_shutdown: { type: 'session_shutdown' };
  before_agent_start: { type: 'before_agent_start'; systemPrompt: string };
  tool_call: { type: 'tool_call'; toolName: string; input: unknown };
}
interface EventResults {
  session_start: void;
  session_shutdown: void;
  before_agent_start: { message: CustomMessage };
  tool_call: { block: true; reason: string } | void;
}
/** The injected host surface used here; no SDK import or ambient module shim. */
export interface Host {
  zod: {
    string(): Schema;
    number(): Schema;
    enum(values: readonly string[]): Schema;
    object(shape: Record<string, Schema>): Schema;
  };
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    loadMode: 'essential';
    parameters: unknown;
    execute(id: string, params: Params, signal: AbortSignal | undefined,
      onUpdate: ((result: ToolResult) => void) | undefined, ctx: Context): Promise<ToolResult>;
  }): void;
  registerCommand(name: string, definition: {
    description: string;
    getArgumentCompletions?(argumentPrefix: string): CommandCompletion[] | null;
    handler(args: string, ctx: Context): Promise<void>;
  }): void;
  on<K extends keyof Events>(name: K,
    handler: (event: Events[K], ctx: Context) => EventResults[K] | Promise<EventResults[K]>): void;
  sendMessage(message: CustomMessage,
    options: { triggerTurn: false; deliverAs: 'nextTurn' }): void;
}
