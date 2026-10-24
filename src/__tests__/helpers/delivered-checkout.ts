import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clearVersionCache } from '../../agent-version.js';
import { saveStateForScope } from '../../config.js';
import { checkoutRecordKey, deliverySelection, type CheckoutRecord } from '../../pull.js';
import { StateSchema, type LocalConfig } from '../../types.js';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf-8' }).trim();
}

export function commitFile(repo: string, file: string, content = `${file}\n`): string {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-qm', file);
  return git(repo, 'rev-parse', 'HEAD');
}

export function initRepo(repo: string): void {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
}

/**
 * Write the checkout record a pull of `rev` into `config`'s checkout leaves, with `delivered` hashing the files as
 * they are now and the selection `config` delivers for. `lastPullRev` defaults to `rev`. `withoutSelection` writes the
 * record an older CLI leaves.
 */
export async function recordDelivery(
  config: LocalConfig,
  { rev, files = [], lastPullRev = rev, withoutSelection = false, ...entry }: Omit<CheckoutRecord, 'delivered' | 'selection'> & { files?: string[]; lastPullRev?: string | null; withoutSelection?: boolean },
): Promise<void> {
  const key = await checkoutRecordKey(config);
  if (!key) throw new Error('config has no checkout record key');
  const delivered = Object.fromEntries(files.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  const selection = withoutSelection ? {} : { selection: deliverySelection(config) };
  await saveStateForScope(StateSchema.parse({ lastPullRev, lastPullByWorkspace: { [key]: { rev, ...entry, ...selection, delivered } } }), config);
}

/** Put an executable `claude` printing `version` first on PATH. Restore PATH with the returned function. */
export function fakeClaude(dir: string, version: string): () => void {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@echo ${version} (Claude Code)\r\n`);
  } else {
    const script = path.join(bin, 'claude');
    fs.writeFileSync(script, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
    fs.chmodSync(script, 0o755);
  }
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
  clearVersionCache();
  return () => {
    process.env.PATH = previous;
    clearVersionCache();
  };
}
