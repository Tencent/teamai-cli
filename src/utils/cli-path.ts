/**
 * Cross-platform command lookup: resolves a CLI name to an absolute path Node can start on this platform.
 *
 * The AI tool launcher (`tool-launch/`) and the provider CLI wrappers (`providers/github/gh-cli.ts`,
 * `providers/cnb/cnb-cli.ts`) share the same traps (on Windows `which` returns an MSYS path, and npm lists its
 * extension-less shim first), so the lookup lives here once.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** CLI 探测超时（毫秒），防止 execFileSync 挂死。 */
export const CLI_DETECT_TIMEOUT_MS = 5_000;

/**
 * 可按扩展名直接启动的 Windows 可执行后缀，按 PATHEXT 优先级排列。
 *
 * `npm install -g` 在 Windows 上同时生成三个 shim：无扩展名的 POSIX 脚本、
 * `<cmd>.cmd`、`<cmd>.ps1`。无扩展名的那个 CreateProcess 无法启动。
 */
export const WIN_EXEC_EXTENSIONS = ['.exe', '.cmd', '.bat'] as const;

/**
 * 从 `where <cmd>` 的输出中挑出可启动的那一条。
 *
 * `where` 会列出所有匹配项，且顺序上无扩展名的 POSIX shim 往往排在前面
 * （例如 `C:\npm\claude` 先于 `C:\npm\claude.cmd`）。无扩展名的文件
 * CreateProcess 无法启动，因此这里只接受可执行后缀。
 *
 * @param whereOutput  `where <cmd>` 的原始 stdout
 * @returns            首个可启动路径；没有可执行后缀时返回 null
 */
export function pickWindowsCommand(whereOutput: string): string | null {
  const lines = whereOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const ext of WIN_EXEC_EXTENSIONS) {
    const hit = lines.find((line) => line.toLowerCase().endsWith(ext));
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * 用 Windows 原生命令 `where` 解析候选 CLI，返回真正的 Windows 路径。
 *
 * `where` 是 `which` 的 Windows 原生等价物，返回 `C:\...\claude.cmd` 这类
 * Windows API 能识别的路径。
 *
 * @param cmd  候选命令名
 * @returns    存在且可启动的绝对路径；未安装时返回 null
 */
function whereOnWindows(cmd: string): string | null {
  try {
    const out = execFileSync('where', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      timeout: CLI_DETECT_TIMEOUT_MS,
    });
    const p = pickWindowsCommand(out);
    return p !== null && existsSync(p) ? p : null;
  } catch {
    // where 未找到时退出码非 0（stderr 为 "INFO: Could not find files..."），走这里
    return null;
  }
}

/**
 * Prefer the caller's PATH, then try login shells for desktop-launched callers.
 */
function whichOnPosix(cmd: string): string | null {
  try {
    const p = execFileSync('which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      timeout: CLI_DETECT_TIMEOUT_MS,
    }).trim();
    if (p && existsSync(p)) return p;
  } catch {
    // Desktop hooks may need the PATH configured by a login shell.
  }

  for (const shell of ['bash', 'zsh']) {
    try {
      const p = execFileSync(shell, ['-lc', 'command -v "$1"', 'teamai-cli', cmd], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        timeout: CLI_DETECT_TIMEOUT_MS,
      }).trim();
      if (p && existsSync(p)) return p;
    } catch {
      // Try the next shell.
    }
  }

  return null;
}

/**
 * 把候选 CLI 命令名解析为存在的绝对路径。
 *
 * Windows 上必须走 `where`：`bash` / `which` 在 Windows 上来自 Git Bash 或 WSL，
 * 返回的是 MSYS 风格路径（如 `/c/Users/me/AppData/Roaming/npm/claude`），
 * Node 对这类路径 `existsSync` 恒为 false，spawn 也无法启动，所以 POSIX 策略在
 * Windows 上永远不可能成功（WSL 的 bash 更会返回完全不可用的 Linux 路径）。
 *
 * `platform` 之所以可注入，是因为仓库 CI 只跑 ubuntu / macos：写死 process.platform
 * 的话 Windows 分支将没有任何测试覆盖（这正是该缺陷长期未被发现的原因）。
 *
 * @param cmd       候选命令名
 * @param platform  目标平台，默认当前进程平台
 * @returns         存在的绝对路径；该平台上不可用时返回 null
 */
export function resolveCliPath(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return platform === 'win32' ? whereOnWindows(cmd) : whichOnPosix(cmd);
}
