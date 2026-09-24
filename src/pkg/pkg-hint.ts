import fs from 'node:fs';
import path from 'node:path';

import { detectProjectConfig, loadLocalConfig } from '../config.js';
import { getTeamaiHome } from '../types.js';
import { ensureDir, readJson, writeJsonAtomic } from '../utils/fs.js';
import { getUserHome } from '../utils/home.js';
import { log } from '../utils/logger.js';
import {
  hasPackageDeclarations,
  loadPackageLock,
  loadPackageManifest,
  packageDeclarationHash,
  packageProjectKey,
  projectNpmDeclarationHash,
  sharedPackageDeclarationHash,
} from './manifest.js';
import type { LocalConfig } from '../types.js';
import type { PackageManifest } from './types.js';

export function buildPackageHintMessage(
  npmCount: number,
  claudeCount: number,
  marketplaceCount = 0,
): string {
  const summary = [
    npmCount > 0 ? `${npmCount} npm package${npmCount === 1 ? '' : 's'}` : '',
    claudeCount > 0 ? `${claudeCount} Claude plugin${claudeCount === 1 ? '' : 's'}` : '',
    marketplaceCount > 0
      ? `${marketplaceCount} Claude marketplace${marketplaceCount === 1 ? '' : 's'}`
      : '',
  ].filter(Boolean).join(' and ');
  return [
    `[teamai:pkg-hint] Team package declarations changed (${summary}).`,
    'Review the packages section, then run `teamai packages` to apply it.',
    'TeamAI never installs third-party package or plugin code automatically at SessionStart.',
  ].join('\n');
}

interface PackageHintState {
  manifestHash: string;
  message: string;
}

async function loadPackageContext(cwd: string): Promise<{
  localConfig: LocalConfig;
  manifest: PackageManifest;
} | null> {
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
  const lock = await loadPackageLock(
    getTeamaiHome(localConfig.scope, localConfig.projectRoot),
  );
  if (isDeclarationAcknowledged(localConfig, manifest, lock, cwd)) return null;

  return {
    manifestHash: packageDeclarationHash(manifest),
    message: buildPackageHintMessage(
      manifest.packages.npm?.length ?? 0,
      manifest.packages.claude?.plugins.length ?? 0,
      manifest.packages.claude?.marketplaces.length ?? 0,
    ),
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
    log.debug(`pkg-hint: ${(error as Error).message}`);
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
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    log.debug(`pkg-hint claim: ${(error as Error).message}`);
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
    log.debug(`pkg-hint: ${(error as Error).message}`);
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
    log.debug(`pkg-hint stash: ${(error as Error).message}`);
  }
}

/** Drain a hint produced after the detached SessionStart pull completed. */
export async function takePendingPackageHint(sessionId: string): Promise<string | null> {
  const filePath = pendingPath(sessionId);
  const pending = await readJson<{ message?: unknown }>(filePath);
  if (!pending || typeof pending.message !== 'string' || !pending.message) return null;
  await fs.promises.unlink(filePath).catch(() => undefined);
  return pending.message;
}
