/**
 * Typed config parsing for GitHub Copilot provider defaults.
 * Validates and narrows the opaque assistantConfig to typed fields.
 */
import type { CopilotProviderDefaults } from '../types';

// Re-export so consumers can import the type from either location
export type { CopilotProviderDefaults } from '../types';

const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
const VALID_MODES = ['interactive', 'plan', 'autopilot'] as const;

/**
 * Parse raw assistantConfig into typed Copilot defaults.
 * Defensive: invalid fields are silently dropped (not thrown).
 */
export function parseCopilotConfig(raw: Record<string, unknown>): CopilotProviderDefaults {
  const result: CopilotProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (
    typeof raw.reasoningEffort === 'string' &&
    (VALID_REASONING_EFFORTS as readonly string[]).includes(raw.reasoningEffort)
  ) {
    result.reasoningEffort = raw.reasoningEffort as CopilotProviderDefaults['reasoningEffort'];
  }

  if (typeof raw.mode === 'string' && (VALID_MODES as readonly string[]).includes(raw.mode)) {
    result.mode = raw.mode as CopilotProviderDefaults['mode'];
  }

  if (Array.isArray(raw.additionalDirectories)) {
    result.additionalDirectories = raw.additionalDirectories.filter(
      (d): d is string => typeof d === 'string'
    );
  }

  if (typeof raw.copilotBinaryPath === 'string') {
    result.copilotBinaryPath = raw.copilotBinaryPath;
  }

  if (typeof raw.configDir === 'string') {
    result.configDir = raw.configDir;
  }

  return result;
}
