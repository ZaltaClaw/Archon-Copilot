import type { ProviderCapabilities } from '../types';

/**
 * GitHub Copilot CLI capabilities.
 *
 * The Copilot CLI (`copilot -p ...`) is a full agentic coding assistant:
 * - Session resume via `--resume=<session-id>`
 * - MCP server support via `--additional-mcp-config`
 * - Tool allow/deny lists via `--allow-tool` / `--deny-tool`
 * - Reasoning effort via `--effort`
 * - Additional directory access via `--add-dir`
 *
 * Not currently supported:
 * - `hooks`     — Copilot hooks live in `~/.copilot` config, not per-invocation YAML.
 * - `skills`    — Skills are discovered from filesystem, not injected per-call.
 * - `structuredOutput` — No `--output-schema` equivalent.
 * - `thinkingControl` — Effort is exposed as `effortControl` instead.
 * - `fallbackModel` — Copilot CLI doesn't support runtime model fallback.
 * - `sandbox`   — Permission scope is controlled via tool/path allow-lists, not a
 *                 sandbox flag equivalent to Codex's.
 * - `costControl` — No `--max-budget-usd` equivalent.
 */
export const COPILOT_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: false,
  toolRestrictions: true,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
