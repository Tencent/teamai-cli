import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { detectProjectConfig, loadLocalConfig, loadTeamAgentLanguage } from '../config.js';
import { DefaultHooks, type DefaultHook, type HintLanguage } from '../default-hooks.js';
import { ensureDir, readJson, writeJsonAtomic } from '../utils/fs.js';
import { getUserHome } from '../utils/home.js';
import { log } from '../utils/logger.js';
import {
  hasPackageDeclarations,
  loadPackageLock,
  loadPackageManifest,
  packageLockDir,
  packageDeclarationHash,
  packageProjectKey,
  projectNpmDeclarationHash,
  sharedPackageDeclarationHash,
} from './manifest.js';
import type { LocalConfig } from '../types.js';
import type { PackageManifest } from './types.js';

/** How many of each kind of package the team declares. */
export interface DeclaredPackageCounts {
  readonly npm: number;
  readonly claude: number;
  readonly marketplace: number;
}

/** The package hint: `hook`'s `message.md` (its variant for `language`), its `{{ summary }}` naming what the team declares. */
export function buildPackageHintMessage(hook: DefaultHook<'teamai-package-hint'>, { npm, claude, marketplace }: DeclaredPackageCounts, language: HintLanguage): string {
  const summary = [
    npm > 0 ? `${npm} npm package${npm === 1 ? '' : 's'}` : '',
    claude > 0 ? `${claude} Claude plugin${claude === 1 ? '' : 's'}` : '',
    marketplace > 0
      ? `${marketplace} Claude marketplace${marketplace === 1 ? '' : 's'}`
      : '',
  ].filter(Boolean).join(' and ');

  return hook.text('message', language).render({ summary });
}

interface PackageHintState {
  manifestHash: string;
  message: string;
}

async function loadPackageContext(cwd: string): Promise<{
  localConfig: LocalConfig;
  manifest: PackageManifest;
} | null> {
  // oxlint-disable-next-line teamai/config-load-options -- session-start package hints retain normal config migration and have no preview option
  const localConfig = await detectProjectConfig(cwd) ?? await loadLocalConfig();

  if (!localConfig || localConfig.repo.kind === 'http') return null;
  const manifest = await loadPackageManifest(localConfig.repo.localPath);

  if (!hasPackageDeclarations(manifest)) return null;

  return { localConfig, manifest };
}

function isDeclarationAcknowledged(
  localConfig: LocalConfig,
  manifest: PackageManifest,
  lock: Awaited<ReturnType<typeof loadPackageLock>>,
  cwd: string,
): boolean {
  if (!lock) return false;

  if (localConfig.scope !== 'user') {
    return lock.declarationHash === packageDeclarationHash(manifest);
  }

  if (lock.declarationHash !== sharedPackageDeclarationHash(manifest)) return false;
  const projectHash = projectNpmDeclarationHash(manifest);

  if (!projectHash) return true;

  return lock.projectDeclarationHashes?.[packageProjectKey(cwd)] === projectHash;
}

async function computePackageHintState(cwd: string): Promise<PackageHintState | null> {
  if (process.env.TEAMAI_PACKAGE_HINT_DISABLED === '1') return null;
  const context = await loadPackageContext(cwd);

  if (!context) return null;
  const { localConfig, manifest } = context;
  const lock = await loadPackageLock(await packageLockDir(localConfig));

  if (isDeclarationAcknowledged(localConfig, manifest, lock, cwd)) return null;

  return {
    manifestHash: packageDeclarationHash(manifest),
    message: buildPackageHintMessage(await DefaultHooks.load('teamai-package-hint', localConfig), {
      npm: manifest.packages.npm?.length ?? 0,
      claude: manifest.packages.claude?.plugins.length ?? 0,
      marketplace: manifest.packages.claude?.marketplaces.length ?? 0,
    }, await loadTeamAgentLanguage(localConfig)),
  };
}

function packageHintOutput(message: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: message,
    },
  });
}

export async function computePackageHintOutput(cwd: string): Promise<string | null> {
  try {
    const state = await computePackageHintState(cwd);

    return state ? packageHintOutput(state.message) : null;
  } catch (error) {
    log.debug(`pkg-hint: ${error instanceof Error ? error.message : String(error)}`);

    return null;
  }
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function packageHintDir(): string {
  return path.join(getUserHome(), '.teamai', 'package-hints');
}

function claimPath(sessionId: string, manifestHash: string): string {
  return path.join(
    packageHintDir(),
    `${sanitizeSessionId(sessionId)}.${manifestHash.slice(0, 16)}.claimed`,
  );
}

function pendingPath(sessionId: string): string {
  return path.join(packageHintDir(), `${sanitizeSessionId(sessionId)}.pending.json`);
}

async function claimPackageHint(sessionId: string, manifestHash: string): Promise<boolean> {
  const filePath = claimPath(sessionId, manifestHash);

  try {
    await ensureDir(path.dirname(filePath));
    await fs.promises.writeFile(filePath, '{}\n', { encoding: 'utf-8', flag: 'wx' });

    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    log.debug(`pkg-hint claim: ${error instanceof Error ? error.message : String(error)}`);

    // A failed dedup marker must not suppress the user-facing safety prompt.
    return true;
  }
}

/** Claim the current declaration once per session before returning its hook output. */
export async function claimPackageHintOutput(
  cwd: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const state = await computePackageHintState(cwd);

    if (!state || !await claimPackageHint(sessionId, state.manifestHash)) return null;

    return packageHintOutput(state.message);
  } catch (error) {
    log.debug(`pkg-hint: ${error instanceof Error ? error.message : String(error)}`);

    return null;
  }
}

/** Read the package declaration before a background pull for change detection. */
export async function packageManifestHashForCwd(cwd: string): Promise<string | null> {
  try {
    const context = await loadPackageContext(cwd);

    return context ? packageDeclarationHash(context.manifest) : null;
  } catch {
    return null;
  }
}

/** Persist a post-pull hint when the detached pull changed package declarations. */
export async function stashPackageHintAfterPull(
  cwd: string,
  sessionId: string,
  beforeHash: string | null,
): Promise<void> {
  try {
    const afterHash = await packageManifestHashForCwd(cwd);

    if (!afterHash || afterHash === beforeHash) return;
    const state = await computePackageHintState(cwd);

    if (!state || !await claimPackageHint(sessionId, state.manifestHash)) return;
    await writeJsonAtomic(pendingPath(sessionId), { message: state.message });
  } catch (error) {
    log.debug(`pkg-hint stash: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A stashed hint; one without a message is not delivered. */
const PendingHintSchema = z.object({ message: z.string().min(1) });

/** Drain a hint produced after the detached SessionStart pull completed. */
export async function takePendingPackageHint(sessionId: string): Promise<string | null> {
  const filePath = pendingPath(sessionId);
  const pending = PendingHintSchema.safeParse(await readJson(filePath));

  if (!pending.success) return null;
  await fs.promises.unlink(filePath).catch(() => undefined);

  return pending.data.message;
}
