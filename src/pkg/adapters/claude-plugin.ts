import path from 'node:path';

import { z } from 'zod';

import { formatCommand } from '../../utils/exec.js';
import { log } from '../../utils/logger.js';
import type {
  ClaudeEcosystem,
  ClaudeMarketplace,
  ClaudeMarketplaceLock,
  ClaudePluginLock,
  PackageStatus,
} from '../types.js';
import {
  PackageAdapter,
  type PackageInstallContext,
} from './base.js';

/** A field of `claude plugin ... list --json` output; one of the wrong type reads as absent. */
const listedString = z.string().optional().catch(undefined);

const ClaudePluginListItemSchema = z.object({
  id: listedString,
  version: listedString,
  scope: listedString,
  enabled: z.boolean().optional().catch(undefined),
  installPath: listedString,
});

export type ClaudePluginListItem = z.infer<typeof ClaudePluginListItemSchema>;

const ClaudeMarketplaceListItemSchema = z.object({
  name: listedString,
  source: listedString,
  repo: listedString,
  url: listedString,
  path: listedString,
  ref: listedString,
  installLocation: listedString,
});

export type ClaudeMarketplaceListItem = z.infer<typeof ClaudeMarketplaceListItemSchema>;

export interface ClaudeLockSection {
  marketplaces: ClaudeMarketplaceLock[];
  plugins: ClaudePluginLock[];
}

function marketplaceSource(marketplace: ClaudeMarketplace): string {
  if (!marketplace.ref) return marketplace.repo;

  const separator = marketplace.repo.includes('://') || marketplace.repo.endsWith('.git')
    ? '#'
    : '@';

  return `${marketplace.repo}${separator}${marketplace.ref}`;
}

/** Resolve the location fields emitted by the different native marketplace source kinds. */
export function marketplaceSourceLocation(
  marketplace: ClaudeMarketplaceListItem,
): string | undefined {
  if (marketplace.repo) return marketplace.repo;

  if (marketplace.url) return marketplace.url;

  if (marketplace.path) return marketplace.path;

  // Older Claude releases sometimes emitted the location directly in source;
  // current releases use source as a kind (github/git/directory).
  if (marketplace.source && /[/:\\]/.test(marketplace.source)) return marketplace.source;

  return undefined;
}

function marketplaceLocationsEqual(declared: string, actual: string, cwd: string): boolean {
  const looksLocal = (value: string) => path.isAbsolute(value)
    || /^\.{1,2}[\\/]/.test(value)
    || /^[a-zA-Z]:[\\/]/.test(value);

  if (looksLocal(declared) || looksLocal(actual)) {
    return path.resolve(cwd, declared) === path.resolve(cwd, actual);
  }

  return declared.replace(/[\\/]+$/, '') === actual.replace(/[\\/]+$/, '');
}

function parseJsonArray<T>(stdout: string, item: z.ZodType<T>): T[] {
  const parsed: unknown = JSON.parse(stdout);

  if (!Array.isArray(parsed)) throw new Error('expected a JSON array');

  return z.array(item).parse(parsed);
}

export class ClaudePluginAdapter extends PackageAdapter<ClaudeEcosystem, ClaudeLockSection> {
  readonly ecosystem = 'claude' as const;

  async detect(_cwd: string): Promise<boolean> {
    try {
      const result = await this.execute('claude', ['plugin', '--help'], { timeoutMs: 5_000 });

      return result.code === 0;
    } catch {
      return false;
    }
  }

  private async queryPlugins(): Promise<ClaudePluginListItem[]> {
    try {
      const result = await this.execute(
        'claude',
        ['plugin', 'list', '--json'],
        { timeoutMs: 30_000 },
      );

      if (result.code !== 0) return [];

      return parseJsonArray(result.stdout, ClaudePluginListItemSchema);
    } catch {
      return [];
    }
  }

  private async queryMarketplaces(): Promise<ClaudeMarketplaceListItem[]> {
    try {
      const result = await this.execute(
        'claude',
        ['plugin', 'marketplace', 'list', '--json'],
        { timeoutMs: 30_000 },
      );

      if (result.code !== 0) return [];

      return parseJsonArray(result.stdout, ClaudeMarketplaceListItemSchema);
    } catch {
      return [];
    }
  }

  async registeredMarketplaces(): Promise<ClaudeMarketplaceListItem[]> {
    return this.queryMarketplaces();
  }

  async snapshot(declaration: ClaudeEcosystem): Promise<ClaudeLockSection> {
    const [marketplaces, plugins] = await Promise.all([
      this.queryMarketplaces(),
      this.queryPlugins(),
    ]);

    const declaredMarketplaces = new Set(declaration.marketplaces.map((item) => item.name));

    const marketplaceDeclarations = new Map(
      declaration.marketplaces.map((item) => [item.name, item]),
    );

    const declaredPlugins = new Set(declaration.plugins.map((item) => item.name));

    return {
      marketplaces: marketplaces
        .filter((item) => item.name && declaredMarketplaces.has(item.name))
        .map((item) => {
          const declared = marketplaceDeclarations.get(item.name!);
          const repo = marketplaceSourceLocation(item) ?? declared?.repo;
          const lock: ClaudeMarketplaceLock = { name: item.name! };

          if (item.source) lock.source = item.source;

          if (repo) lock.repo = repo;

          if (declared?.ref) lock.ref = declared.ref;

          if (item.installLocation) lock.installLocation = item.installLocation;

          return lock;
        }),
      plugins: plugins
        .filter((item) => item.id && declaredPlugins.has(item.id))
        .map((item) => {
          const lock: ClaudePluginLock = {
            id: item.id!,
            version: item.version ?? 'unknown',
            scope: item.scope ?? 'user',
            enabled: item.enabled ?? true,
          };

          if (item.installPath) lock.installPath = item.installPath;

          return lock;
        }),
    };
  }

  async install(
    declaration: ClaudeEcosystem,
    context: PackageInstallContext,
  ): Promise<ClaudeLockSection> {
    if (declaration.marketplaces.length === 0 && declaration.plugins.length === 0) {
      return { marketplaces: [], plugins: [] };
    }

    if (context.dryRun) {
      for (const marketplace of declaration.marketplaces) {
        const args = [
          'plugin', 'marketplace', 'add', marketplaceSource(marketplace),
          '--scope', context.scope,
        ];

        log.info(`[dry-run] Would run: ${formatCommand('claude', args)}`);
      }

      for (const plugin of declaration.plugins) {
        const args = [
          'plugin', 'install', plugin.name,
          '--scope', plugin.scope ?? context.scope,
          '--yes',
        ];

        log.info(`[dry-run] Would run: ${formatCommand('claude', args)}`);
      }

      return { marketplaces: [], plugins: [] };
    }

    if (!await this.detect(context.cwd)) {
      throw new Error(
        'Claude plugin CLI is unavailable. Install or upgrade Claude Code, then retry.',
      );
    }

    const installedMarketplaces = new Map(
      (await this.queryMarketplaces()).flatMap(
        (item) => item.name ? [[item.name, item] as const] : [],
      ),
    );

    const previousMarketplaces = new Map(
      (context.previousPackages?.claude?.marketplaces ?? []).map((item) => [item.name, item]),
    );

    for (const marketplace of declaration.marketplaces) {
      const installed = installedMarketplaces.get(marketplace.name);
      const previous = previousMarketplaces.get(marketplace.name);
      const installedRepo = installed ? marketplaceSourceLocation(installed) : undefined;

      const sourceChanged = !!installedRepo
        && !marketplaceLocationsEqual(marketplace.repo, installedRepo, context.cwd);

      const declarationChanged = !!previous
        && (previous.repo !== marketplace.repo || previous.ref !== marketplace.ref);

      // Native list JSON does not expose a Git ref. Without a TeamAI snapshot,
      // re-add a pinned marketplace once so the requested ref is actually applied.
      const pinnedButUnverified = !!installed && !!marketplace.ref && !previous?.ref;
      const replace = !!installed && (sourceChanged || declarationChanged || pinnedButUnverified);

      if (replace) {
        const remove = await this.execute(
          'claude',
          ['plugin', 'marketplace', 'remove', marketplace.name, '--scope', context.scope],
          { cwd: context.cwd, timeoutMs: 120_000, stream: true },
        );

        if (remove.code !== 0) {
          throw new Error(
            `Claude marketplace replacement failed for "${marketplace.name}" (exit ${remove.code}): `
            + remove.stderr.trim(),
          );
        }
      }

      if (installed && !replace) continue;

      const result = await this.execute('claude', [
        'plugin', 'marketplace', 'add', marketplaceSource(marketplace),
        '--scope', context.scope,
      ], {
        cwd: context.cwd,
        timeoutMs: 120_000,
        stream: true,
      });

      if (result.code !== 0) {
        throw new Error(
          `Claude marketplace add failed for "${marketplace.name}" (exit ${result.code}): `
          + result.stderr.trim(),
        );
      }
    }

    for (const plugin of declaration.plugins) {
      const result = await this.execute('claude', [
        'plugin', 'install', plugin.name,
        '--scope', plugin.scope ?? context.scope,
        '--yes',
      ], {
        cwd: context.cwd,
        timeoutMs: 120_000,
        stream: true,
      });

      if (result.code !== 0) {
        throw new Error(
          `Claude plugin install failed for "${plugin.name}" (exit ${result.code}): `
          + result.stderr.trim(),
        );
      }
    }

    return this.snapshot(declaration);
  }

  async status(
    declaration: ClaudeEcosystem,
    _context: PackageInstallContext,
  ): Promise<PackageStatus[]> {
    const installed = new Map(
      (await this.queryPlugins()).flatMap((item) => item.id ? [[item.id, item] as const] : []),
    );

    return declaration.plugins.map((plugin) => {
      const actual = installed.get(plugin.name);

      const versionMismatch = plugin.version
        && actual?.version
        && actual.version !== 'unknown'
        && plugin.version !== actual.version;

      const status: PackageStatus = { name: plugin.name, installed: !!actual && !versionMismatch };

      if (actual?.version) status.version = actual.version;

      if (actual) status.enabled = actual.enabled ?? true;

      if (!actual) {
        status.detail = 'declared but not installed';
      } else if (versionMismatch) {
        status.detail = `declared ${plugin.version}, installed ${actual.version}`;
      }

      return status;
    });
  }

  async marketplaceStatus(
    declaration: ClaudeEcosystem,
    context: PackageInstallContext,
  ): Promise<PackageStatus[]> {
    const registered = new Map(
      (await this.queryMarketplaces()).flatMap(
        (item) => item.name ? [[item.name, item] as const] : [],
      ),
    );

    const snapshots = new Map(
      (context.previousPackages?.claude?.marketplaces ?? []).map((item) => [item.name, item]),
    );

    return declaration.marketplaces.map((marketplace) => {
      const actual = registered.get(marketplace.name);

      if (!actual) {
        return {
          name: marketplace.name,
          installed: false,
          detail: 'declared but not registered',
        };
      }

      const actualLocation = marketplaceSourceLocation(actual);

      if (!actualLocation) {
        return {
          name: marketplace.name,
          installed: false,
          detail: 'registered but source could not be determined',
        };
      }

      if (!marketplaceLocationsEqual(marketplace.repo, actualLocation, context.cwd)) {
        return {
          name: marketplace.name,
          installed: false,
          detail: `declared ${marketplace.repo}, registered ${actualLocation}`,
        };
      }

      if (marketplace.ref) {
        const snapshot = snapshots.get(marketplace.name);

        const actualRef = actual.ref ?? (
          snapshot?.repo
          && marketplaceLocationsEqual(marketplace.repo, snapshot.repo, context.cwd)
            ? snapshot.ref
            : undefined
        );

        if (actualRef !== marketplace.ref) {
          return {
            name: marketplace.name,
            installed: false,
            detail: `registered source matches, but ref ${marketplace.ref} is not verified`,
          };
        }
      }

      return {
        name: marketplace.name,
        installed: true,
        detail: marketplace.ref
          ? `${actualLocation}@${marketplace.ref}`
          : actualLocation,
      };
    });
  }
}
