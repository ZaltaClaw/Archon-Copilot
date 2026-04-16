/**
 * GitHub Copilot CLI provider
 * Provides async generator interface for streaming Copilot responses
 *
 * The Copilot CLI (`copilot`) is a full agentic coding assistant that can:
 * - Execute prompts against a codebase with file read/write, shell exec
 * - Resume sessions via `--resume=<session-id>`
 * - Accept MCP server configs via `--additional-mcp-config`
 * - Restrict tools via `--allow-tool` / `--deny-tool`
 * - Control reasoning effort via `--effort`
 *
 * Authentication:
 * - Uses `copilot login` or GH_TOKEN / COPILOT_GITHUB_TOKEN env vars
 *
 * Binary resolution:
 * - See ./binary-resolver.ts for resolution order
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import type {
  IAgentProvider,
  SendQueryOptions,
  MessageChunk,
  ProviderCapabilities,
} from '../types';
import { parseCopilotConfig } from './config';
import { COPILOT_CAPABILITIES } from './capabilities';
import { resolveCopilotBinaryPath } from './binary-resolver';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot');
  return cachedLog;
}

// ─── Error Classification ────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
const AUTH_PATTERNS = ['unauthorized', 'authentication', 'invalid token', '401', '403', 'login'];

function classifyCopilotError(msg: string): 'rate_limit' | 'auth' | 'unknown' {
  const m = msg.toLowerCase();
  if (RATE_LIMIT_PATTERNS.some(p => m.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => m.includes(p))) return 'auth';
  return 'unknown';
}

// ─── Copilot Provider ────────────────────────────────────────────────────

/**
 * GitHub Copilot AI agent provider.
 * Implements IAgentProvider by spawning the `copilot` CLI as a subprocess
 * and streaming its JSON-lines output into Archon MessageChunks.
 */
export class CopilotProvider implements IAgentProvider {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  getType(): string {
    return 'copilot';
  }

  getCapabilities(): ProviderCapabilities {
    return COPILOT_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const config = parseCopilotConfig(assistantConfig);

    // Resolve binary
    const binaryPath = await resolveCopilotBinaryPath(config.copilotBinaryPath);

    // Build args
    const args = this.buildArgs(prompt, resumeSessionId, requestOptions, config);

    // Build env
    const env = this.buildEnv(requestOptions?.env);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      if (attempt > 0) {
        const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
        getLog().info({ attempt, delayMs }, 'retrying_query');
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      try {
        yield* this.executeAndStream(binaryPath, args, cwd, env, requestOptions?.abortSignal);
        return;
      } catch (error) {
        const err = error as Error;
        const errorClass = classifyCopilotError(err.message);

        getLog().error({ err, errorClass, attempt, maxRetries: MAX_RETRIES }, 'query_error');

        if (errorClass === 'auth') {
          throw new Error(
            `Copilot authentication error: ${err.message}\n\n` +
              'To fix: run `copilot login` or set GH_TOKEN / COPILOT_GITHUB_TOKEN.\n' +
              'A GitHub Copilot subscription is required.'
          );
        }

        if (errorClass !== 'rate_limit' || attempt >= MAX_RETRIES) {
          throw err;
        }

        lastError = err;
      }
    }

    throw lastError ?? new Error('Copilot query failed after retries');
  }

  /**
   * Build CLI arguments for the copilot binary.
   * The copilot CLI accepts: copilot -p "prompt" [flags]
   */
  private buildArgs(
    prompt: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions,
    config?: ReturnType<typeof parseCopilotConfig>
  ): string[] {
    const args: string[] = ['-p', prompt, '--output-format', 'stream-json'];

    // Session resume
    if (resumeSessionId) {
      args.push(`--resume=${resumeSessionId}`);
    }

    // Model override
    const model = requestOptions?.model ?? config?.model;
    if (model) {
      args.push('--model', model);
    }

    // Reasoning effort from nodeConfig or config
    const effort = requestOptions?.nodeConfig?.effort ?? config?.reasoningEffort;
    if (effort && typeof effort === 'string') {
      args.push('--effort', effort);
    }

    // Tool restrictions
    if (requestOptions?.nodeConfig?.allowed_tools) {
      for (const tool of requestOptions.nodeConfig.allowed_tools) {
        args.push('--allow-tool', tool);
      }
    }
    if (requestOptions?.nodeConfig?.denied_tools) {
      for (const tool of requestOptions.nodeConfig.denied_tools) {
        args.push('--deny-tool', tool);
      }
    }

    // MCP config
    if (requestOptions?.nodeConfig?.mcp) {
      args.push('--additional-mcp-config', requestOptions.nodeConfig.mcp);
    }

    // Additional directories
    const addDirs = config?.additionalDirectories ?? [];
    for (const dir of addDirs) {
      args.push('--add-dir', dir);
    }

    // System prompt
    if (requestOptions?.systemPrompt) {
      // Write system prompt to temp file and pass via --system-prompt-file
      const tmpDir = join(tmpdir(), 'archon-copilot');
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      const sysPromptFile = join(tmpDir, `sysprompt-${Date.now()}.md`);
      writeFileSync(sysPromptFile, requestOptions.systemPrompt, 'utf-8');
      args.push('--system-prompt-file', sysPromptFile);
    }

    return args;
  }

  /**
   * Build process environment.
   */
  private buildEnv(requestEnv?: Record<string, string>): Record<string, string> {
    const baseEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    );
    return { ...baseEnv, ...(requestEnv ?? {}) };
  }

  /**
   * Spawn the copilot CLI and stream its JSON-lines output as MessageChunks.
   */
  private async *executeAndStream(
    binaryPath: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    abortSignal?: AbortSignal
  ): AsyncGenerator<MessageChunk> {
    getLog().info({ binaryPath, args: args.join(' '), cwd }, 'spawning_copilot');

    const proc: ChildProcess = spawn(binaryPath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately — copilot reads prompt from -p flag
    proc.stdin?.end();

    let sessionId: string | undefined;
    let stderrBuffer = '';

    // Collect stderr for error reporting
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    // Handle abort
    if (abortSignal) {
      const abortHandler = (): void => {
        proc.kill('SIGTERM');
      };
      abortSignal.addEventListener('abort', abortHandler, { once: true });
      proc.on('exit', () => {
        abortSignal.removeEventListener('abort', abortHandler);
      });
    }

    // Stream stdout as JSON lines
    const stdout = proc.stdout;
    if (!stdout) {
      throw new Error('Failed to open stdout from copilot process');
    }

    let lineBuffer = '';

    try {
      for await (const chunk of stdout as AsyncIterable<Buffer | string>) {
        if (abortSignal?.aborted) {
          proc.kill('SIGTERM');
          throw new Error('Query aborted');
        }

        lineBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        const lines = lineBuffer.split('\n');
        // Keep the last (potentially incomplete) line in the buffer
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(trimmed);
          } catch {
            // Non-JSON output — emit as assistant text
            yield { type: 'assistant', content: trimmed + '\n' };
            continue;
          }

          yield* this.handleEvent(event);

          // Capture session ID from session events
          if (event.type === 'session.start' || event.type === 'session.resume') {
            sessionId = (event.session_id ?? event.sessionId) as string | undefined;
          }
        }
      }

      // Process any remaining data in the buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer.trim());
          yield* this.handleEvent(event);
        } catch {
          yield { type: 'assistant', content: lineBuffer.trim() };
        }
      }
    } catch (err) {
      if ((err as Error).message === 'Query aborted') throw err;
      getLog().error({ err }, 'stdout_stream_error');
    }

    // Wait for process to exit
    const exitCode = await new Promise<number | null>(resolve => {
      if (proc.exitCode !== null) {
        resolve(proc.exitCode);
      } else {
        proc.on('exit', code => {
          resolve(code);
        });
      }
    });

    if (exitCode !== 0 && exitCode !== null) {
      const errorMsg = stderrBuffer.trim() || `copilot exited with code ${exitCode}`;
      getLog().error({ exitCode, stderr: stderrBuffer.slice(0, 500) }, 'copilot_exit_error');
      throw new Error(errorMsg);
    }

    // Emit final result
    yield {
      type: 'result',
      sessionId,
    };
  }

  /**
   * Convert a single Copilot JSON-lines event into MessageChunk(s).
   * Event schema mirrors the Copilot CLI's --output-format=stream-json.
   */
  private *handleEvent(event: Record<string, unknown>): Generator<MessageChunk> {
    const eventType = event.type as string | undefined;

    switch (eventType) {
      case 'agent_message':
      case 'message':
      case 'text':
        if (event.text || event.content) {
          yield { type: 'assistant', content: (event.text ?? event.content) as string };
        }
        break;

      case 'thinking':
      case 'reasoning':
        if (event.text || event.content) {
          yield { type: 'thinking', content: (event.text ?? event.content) as string };
        }
        break;

      case 'command_execution':
      case 'tool_use': {
        const cmd = (event.command ?? event.tool ?? event.name) as string | undefined;
        if (cmd) {
          yield { type: 'tool', toolName: cmd };
          const output = (event.output ?? event.result ?? event.aggregated_output ?? '') as string;
          const exitCode = event.exit_code as number | null | undefined;
          const exitSuffix = exitCode != null && exitCode !== 0 ? `\n[exit code: ${exitCode}]` : '';
          yield { type: 'tool_result', toolName: cmd, toolOutput: output + exitSuffix };
        }
        break;
      }

      case 'file_change': {
        const changes = event.changes as { kind: string; path?: string }[] | undefined;
        if (Array.isArray(changes) && changes.length > 0) {
          const changeList = changes
            .map(c => {
              const icon = c.kind === 'add' ? '➕' : c.kind === 'delete' ? '➖' : '📝';
              return `${icon} ${c.path ?? '(unknown)'}`;
            })
            .join('\n');
          yield { type: 'system', content: `File changes:\n${changeList}` };
        }
        break;
      }

      case 'todo_list': {
        const items = event.items as { text?: string; completed?: boolean }[] | undefined;
        if (Array.isArray(items) && items.length > 0) {
          const taskList = items
            .map(t => `${t.completed ? '✅' : '⬜'} ${t.text ?? '(unnamed)'}`)
            .join('\n');
          yield { type: 'system', content: `📋 Tasks:\n${taskList}` };
        }
        break;
      }

      case 'mcp_tool_call': {
        const server = event.server as string | undefined;
        const tool = event.tool as string | undefined;
        const toolInfo = server && tool ? `${server}/${tool}` : (tool ?? server ?? 'MCP tool');
        const mcpToolName = `🔌 MCP: ${toolInfo}`;
        yield { type: 'tool', toolName: mcpToolName };
        const mcpOutput = event.result ? JSON.stringify(event.result) : '';
        yield { type: 'tool_result', toolName: mcpToolName, toolOutput: mcpOutput };
        break;
      }

      case 'error':
        if (event.message) {
          yield { type: 'system', content: `⚠️ ${event.message as string}` };
        }
        break;

      case 'turn.completed':
      case 'session.end':
        // Handled by the caller (result chunk emitted after process exit)
        break;

      case 'session.start':
      case 'session.resume':
        getLog().debug({ sessionId: event.session_id ?? event.sessionId }, eventType);
        break;

      default:
        // Unknown event types — log and skip
        if (eventType) {
          getLog().debug({ eventType }, 'unknown_copilot_event');
        }
        break;
    }
  }
}
