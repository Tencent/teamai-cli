import path from 'node:path';
import { log } from './utils/logger.js';
import { pathExists } from './utils/fs.js';
import { getUserHome } from './utils/home.js';
import { ModelConfigService } from './model/service.js';
import { DEFAULT_PROVIDER, getProvider, listProviders, resolveApiKey } from './model/providers.js';
import {
  getToolTarget,
  plannedToolNames,
  supportedToolNames,
  unsupportedTools,
} from './model/tool-targets.js';
import type { GlobalOptions } from './types.js';

export interface ModelInjectCliOptions extends GlobalOptions {
  provider?: string;
  tool?: string | string[];
  endpoint?: string;
}

/** Normalize a repeatable/comma-separated `--tool` option into a deduplicated id list. */
function normalizeToolList(tool?: string | string[]): string[] {
  if (tool === undefined) return [];
  const raw = Array.isArray(tool) ? tool : [tool];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw) {
    for (const piece of String(part).split(',')) {
      const id = piece.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/** Collapse the user's home prefix to `~` for display. */
function displayPath(filePath: string): string {
  const home = getUserHome();
  if (filePath === home || filePath.startsWith(home + path.sep)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

/** Tools whose config directory already exists (i.e. the tool is installed). */
async function detectInstalledTools(home: string): Promise<string[]> {
  const installed: string[] = [];
  for (const name of supportedToolNames()) {
    const configDir = path.dirname(getToolTarget(name).configPath(home));
    if (await pathExists(configDir)) installed.push(name);
  }
  return installed;
}

/**
 * Inject a provider's model config into one or more AI tools.
 *
 * `--provider` defaults to deepseek. With no `--tool`, every installed supported
 * tool is targeted. The provider's API-key env var must be set. On failure for a
 * tool, the remaining tools are still processed and the process exits non-zero.
 */
export async function modelInject(options: ModelInjectCliOptions): Promise<void> {
  const providerId = options.provider ?? DEFAULT_PROVIDER;
  getProvider(providerId); // validate early; throws with the available provider list

  const home = getUserHome();
  const requested = normalizeToolList(options.tool);
  const tools = requested.length > 0 ? requested : await detectInstalledTools(home);
  if (tools.length === 0) {
    throw new Error(`No installed AI tools detected among: ${supportedToolNames().join(', ')}`);
  }

  const service = new ModelConfigService();
  const written: Array<{ tool: string; file: string }> = [];
  let failed = 0;

  for (const tool of tools) {
    try {
      if (options.dryRun) {
        const plan = service.render({ providerId, tool, endpoint: options.endpoint });
        process.stdout.write(`--- ${tool} (${displayPath(plan.configFile.filePath)}) ---\n`);
        process.stdout.write(plan.text ?? '');
        written.push({ tool, file: plan.configFile.filePath });
      } else {
        const plan = await service.apply({ providerId, tool, endpoint: options.endpoint });
        written.push({ tool, file: plan.configFile.filePath });
      }
    } catch (error) {
      log.error(`${tool}: ${(error as Error).message}`);
      failed += 1;
    }
  }

  if (written.length > 0) {
    if (options.dryRun) {
      log.info(`Dry run: provider "${providerId}" would be written to ${written.length} tool(s).`);
    } else {
      log.success(`Injected provider "${providerId}" into ${written.length} tool(s):`);
      for (const item of written) log.info(`  ${item.tool.padEnd(10)} ${displayPath(item.file)}`);
      log.info('Restart your AI tool session to load the new model config.');
    }
  }
  if (failed > 0) process.exitCode = 1;
}

/** Print the built-in providers and the model-inject support status of each known tool. */
export async function modelList(_options: GlobalOptions): Promise<void> {
  const home = getUserHome();
  const providers = listProviders();
  console.log(`Providers (${providers.length}):`);
  for (const provider of providers) {
    const key = resolveApiKey(provider);
    const env = key.isPlaceholder ? key.envName : '(literal)';
    const suffix = provider.provider === DEFAULT_PROVIDER ? ' (default)' : '';
    console.log(`  ${provider.provider.padEnd(12)} ${provider.name.padEnd(18)} ${env}${suffix}`);
  }

  console.log('');
  console.log('Tools:');
  for (const name of supportedToolNames()) {
    const file = getToolTarget(name).configPath(home);
    const installed = await pathExists(path.dirname(file));
    const status = installed ? 'installed' : 'not installed';
    console.log(`  ${name.padEnd(12)} supported    ${status.padEnd(14)} ${displayPath(file)}`);
  }
  for (const { name, reason } of unsupportedTools()) {
    console.log(`  ${name.padEnd(12)} unsupported  ${reason}`);
  }
  for (const name of plannedToolNames()) {
    console.log(`  ${name.padEnd(12)} planned      not supported yet`);
  }
}
