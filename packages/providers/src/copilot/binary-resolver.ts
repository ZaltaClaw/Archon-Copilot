/**
 * GitHub Copilot CLI resolver.
 *
 * Unlike Claude and Codex (which use an in-process SDK that auto-resolves from
 * node_modules in dev mode), the Copilot CLI is always invoked as an external
 * subprocess. We therefore resolve the binary path in ALL modes (dev + binary),
 * not only when running as a compiled Archon binary.
 *
 * Resolution order:
 * 1. `COPILOT_BIN_PATH` environment variable
 * 2. `assistants.copilot.copilotBinaryPath` in config
 * 3. `~/.local/bin/copilot` — default install location for the curl/bash installer
 *    (https://gh.io/copilot-install) running as a non-root user.
 * 4. `/usr/local/bin/copilot` — default install location when running as root.
 * 5. Search `PATH` via platform `which` / `where` equivalent.
 * 6. Throw with install instructions.
 *
 * Install: https://gh.io/copilot-install (curl), `brew install copilot-cli`,
 *          or `npm install -g @github/copilot`.
 */
import { existsSync as _existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@archon/paths';

const execFileAsync = promisify(execFile);

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('copilot-binary');
  return cachedLog;
}

const INSTALL_INSTRUCTIONS =
  'GitHub Copilot CLI not found. Archon requires the `copilot` binary to be\n' +
  'reachable on PATH or via configuration.\n\n' +
  'To fix, install the Copilot CLI and/or point Archon at it:\n\n' +
  '  macOS / Linux (recommended):\n' +
  '    curl -fsSL https://gh.io/copilot-install | bash\n' +
  '    # installs to ~/.local/bin/copilot (or /usr/local/bin when run as root)\n\n' +
  '  macOS / Linux (Homebrew):\n' +
  '    brew install copilot-cli\n\n' +
  '  Windows (winget):\n' +
  '    winget install GitHub.Copilot\n\n' +
  '  Any platform (npm):\n' +
  '    npm install -g @github/copilot\n\n' +
  'If installed to a non-standard location, tell Archon where to find it:\n' +
  '    export COPILOT_BIN_PATH="/path/to/copilot"\n\n' +
  'Or set it persistently in ~/.archon/config.yaml:\n' +
  '    assistants:\n' +
  '      copilot:\n' +
  '        copilotBinaryPath: /path/to/copilot\n\n' +
  'After install, run `copilot login` once to authenticate (or set COPILOT_GITHUB_TOKEN / GH_TOKEN).\n' +
  'A GitHub Copilot subscription is required. See: https://github.com/github/copilot-cli';

/**
 * Probe `PATH` for the copilot binary using the platform's native resolver.
 * Returns undefined if not found or the lookup fails.
 */
async function probePath(): Promise<string | undefined> {
  const command = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(command, ['copilot']);
    // `where` on Windows may return multiple lines — take the first.
    const first = stdout.split(/\r?\n/).find(line => line.trim().length > 0);
    return first?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the path to the `copilot` CLI binary.
 *
 * Always returns an absolute path or throws — Copilot is an external subprocess,
 * so there is no "let the SDK resolve it" escape hatch like Claude/Codex have.
 */
export async function resolveCopilotBinaryPath(configCopilotBinaryPath?: string): Promise<string> {
  // 1. Environment variable override
  const envPath = process.env.COPILOT_BIN_PATH;
  if (envPath) {
    if (!fileExists(envPath)) {
      throw new Error(
        `COPILOT_BIN_PATH is set to "${envPath}" but the file does not exist.\n` +
          'Please verify the path points to the GitHub Copilot CLI executable.'
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'copilot.binary_resolved');
    return envPath;
  }

  // 2. Config file override
  if (configCopilotBinaryPath) {
    if (!fileExists(configCopilotBinaryPath)) {
      throw new Error(
        `assistants.copilot.copilotBinaryPath is set to "${configCopilotBinaryPath}" but the file does not exist.\n` +
          'Please verify the path in .archon/config.yaml points to the Copilot CLI executable.'
      );
    }
    getLog().info(
      { binaryPath: configCopilotBinaryPath, source: 'config' },
      'copilot.binary_resolved'
    );
    return configCopilotBinaryPath;
  }

  // 3. Well-known install locations from the official installer.
  const candidates: string[] = [];
  const home = homedir();
  if (process.platform === 'win32') {
    candidates.push(join(home, '.local', 'bin', 'copilot.exe'));
    candidates.push(join(home, 'AppData', 'Local', 'Programs', 'copilot', 'copilot.exe'));
  } else {
    candidates.push(join(home, '.local', 'bin', 'copilot'));
    candidates.push('/usr/local/bin/copilot');
    candidates.push('/opt/homebrew/bin/copilot');
  }
  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      getLog().info({ binaryPath: candidate, source: 'well-known' }, 'copilot.binary_resolved');
      return candidate;
    }
  }

  // 4. PATH lookup (covers npm global installs, custom directories on PATH).
  const pathHit = await probePath();
  if (pathHit && fileExists(pathHit)) {
    getLog().info({ binaryPath: pathHit, source: 'path' }, 'copilot.binary_resolved');
    return pathHit;
  }

  // 5. Not found — throw with install instructions.
  throw new Error(INSTALL_INSTRUCTIONS);
}
