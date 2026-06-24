import path from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import { ResourceHandler } from './base.js';
import type { ResourceItem, TeamaiConfig, LocalConfig } from '../types.js';
import { TEAMAI_ENV_START, TEAMAI_ENV_END, getTeamaiHome } from '../types.js';
import { pathExists, readFileSafe, writeFile, ensureDir } from '../utils/fs.js';
import { log } from '../utils/logger.js';

// ─── Schema for env.yaml ────────────────────────────────

const EnvVariableSchema = z.object({
  key: z.string(),
  value: z.string(),
  description: z.string().optional(),
});

const EnvYamlSchema = z.object({
  variables: z.array(EnvVariableSchema).default([]),
});

export type EnvVariable = z.infer<typeof EnvVariableSchema>;
export type EnvYaml = z.infer<typeof EnvYamlSchema>;

/**
 * Quote a string so it is safe to interpolate into a POSIX shell (bash/zsh/sh).
 * Wraps the value in single quotes and encodes any embedded single quote as
 * `'\''`, leaving all other characters (including `"`, `$`, `` ` ``, `\`)
 * literal. Used when generating env.sh, which every team member sources.
 */
function shellQuoteValue(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ─── Handler ─────────────────────────────────────────────

export class EnvHandler extends ResourceHandler {
  readonly type = 'env' as const;

  /**
   * Scan for local env changes that need to be pushed.
   * Compares local env/env.yaml against the committed version.
   */
  async scanLocalForPush(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const envYamlPath = path.join(localConfig.repo.localPath, 'env', 'env.yaml');
    if (!await pathExists(envYamlPath)) return [];

    // Check if env.yaml has uncommitted changes via git diff
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    try {
      // git diff exits 0 if no changes, non-zero otherwise when used with --exit-code
      await execFileAsync('git', ['diff', '--exit-code', 'env/env.yaml'], {
        cwd: localConfig.repo.localPath,
      });
      // Also check if the file is untracked
      const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', 'env/env.yaml'], {
        cwd: localConfig.repo.localPath,
      });
      if (!stdout.trim()) return [];
    } catch {
      // git diff --exit-code returns 1 when there are changes — that's what we want
    }

    return [{
      name: 'env.yaml',
      type: 'env',
      sourcePath: envYamlPath,
      relativePath: 'env/env.yaml',
    }];
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const envYamlPath = path.join(localConfig.repo.localPath, 'env', 'env.yaml');
    if (!await pathExists(envYamlPath)) return [];

    return [{
      name: 'env.yaml',
      type: 'env',
      sourcePath: envYamlPath,
      relativePath: 'env/env.yaml',
    }];
  }

  async pushItem(_item: ResourceItem, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    // No-op — env.yaml is already in the repo dir; push.ts handles git commit
  }

  /**
   * Pull env variables: parse env.yaml, write env.sh, inject source line into shell profile.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const content = await readFileSafe(item.sourcePath);
    if (!content) return;

    let envConfig: EnvYaml;
    try {
      const raw = YAML.parse(content);
      envConfig = EnvYamlSchema.parse(raw);
    } catch (e) {
      log.warn(`Invalid env.yaml format: ${(e as Error).message}`);
      return;
    }

    if (envConfig.variables.length === 0) return;

    // Write <teamaiHome>/env (KEY=VALUE backup for loadEnvFile compatibility)
    const teamaiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
    const backupLines = envConfig.variables.map(v => `${v.key}=${v.value}`);
    await ensureDir(teamaiHome);
    await writeFile(path.join(teamaiHome, 'env'), backupLines.join('\n') + '\n');

    // Write <teamaiHome>/env.sh (sourceable export file)
    const envShContent = this.generateEnvFile(envConfig.variables);
    await writeFile(path.join(teamaiHome, 'env.sh'), envShContent);

    // Inject source line into shell profile if enabled
    const inject = teamConfig.sharing.env.injectShellProfile !== false;

    if (inject) {
      const profilePath = teamConfig.sharing.env.shellProfilePath
        ? teamConfig.sharing.env.shellProfilePath
        : this.detectShellProfile();

      const shellBlock = this.generateShellBlock(teamaiHome);
      await this.injectShellProfile(profilePath, shellBlock);
    }
  }

  /**
   * Count the number of env variables in env.yaml.
   */
  async countEnvVars(sourcePath: string): Promise<number> {
    const content = await readFileSafe(sourcePath);
    if (!content) return 0;

    try {
      const raw = YAML.parse(content);
      const envConfig = EnvYamlSchema.parse(raw);
      return envConfig.variables.length;
    } catch {
      return 0;
    }
  }

  /**
   * Parse the env.yaml file and return variables.
   */
  async parseEnvYaml(filePath: string): Promise<EnvYaml> {
    const content = await readFileSafe(filePath);
    if (!content) return { variables: [] };

    try {
      const raw = YAML.parse(content);
      return EnvYamlSchema.parse(raw);
    } catch {
      return { variables: [] };
    }
  }

  /**
   * Write env.yaml with the given variables.
   */
  async writeEnvYaml(filePath: string, envConfig: EnvYaml): Promise<void> {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, YAML.stringify(envConfig));
  }

  /**
   * Generate the shell block with a source line (instead of inline exports).
   */
  generateShellBlock(teamaiHome: string): string {
    const lines = [
      TEAMAI_ENV_START,
      '# DO NOT EDIT: This section is auto-managed by teamai',
      `[ -f ${teamaiHome}/env.sh ] && source ${teamaiHome}/env.sh`,
      TEAMAI_ENV_END,
    ];
    return lines.join('\n');
  }

  /**
   * Generate the content of ~/.teamai/env.sh with export statements.
   *
   * Values are single-quoted so shell metacharacters in an env value (quotes,
   * `$`, backticks, `\`, …) are taken literally and cannot break or inject into
   * the sourced script. An embedded single quote is encoded with the standard
   * `'\''` sequence. env.sh is sourced from every team member's shell profile,
   * so values (which originate from the team repo's env/env.yaml) must be safe.
   */
  generateEnvFile(variables: EnvVariable[]): string {
    const lines = variables.map(v => `export ${v.key}=${shellQuoteValue(v.value)}`);
    return lines.join('\n') + '\n';
  }

  /**
   * Detect the user's shell profile path.
   */
  private detectShellProfile(): string {
    const home = process.env.HOME ?? '';
    const shell = process.env.SHELL ?? '';

    if (shell.includes('zsh')) {
      return path.join(home, '.zshrc');
    }
    return path.join(home, '.bashrc');
  }

  /**
   * Inject the shell block into the profile file (idempotent).
   */
  private async injectShellProfile(profilePath: string, block: string): Promise<void> {
    let content = await readFileSafe(profilePath) ?? '';

    const startIdx = content.indexOf(TEAMAI_ENV_START);
    const endIdx = content.indexOf(TEAMAI_ENV_END);

    if (startIdx !== -1 && endIdx !== -1) {
      // Replace existing block
      const before = content.substring(0, startIdx);
      const after = content.substring(endIdx + TEAMAI_ENV_END.length);
      content = before + block + after;
    } else {
      // Append block
      if (content.length > 0 && !content.endsWith('\n')) {
        content += '\n';
      }
      content += '\n' + block + '\n';
    }

    await writeFile(profilePath, content);
  }

  async removeItem(_name: string, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<string[]> {
    log.warn('Use `teamai env remove <key>` to manage env variables.');
    return [];
  }
}
