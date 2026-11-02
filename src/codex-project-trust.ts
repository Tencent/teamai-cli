/**
 * Codex's verdict on a project, for every resource Codex reads only in a
 * trusted project. `locate` declares the gate (`ReadGate`); this module
 * evaluates it, because the verdict needs a TOML parse and git's checkout
 * anchors. Read-only: granting trust is codex-trust.ts.
 */
import { z } from 'zod';
import type { ReadGate } from './locate.js';
import { pathExists, readFileSafe } from './utils/fs.js';
import { withoutTomlBom } from './utils/toml.js';

/** Codex's `[projects]` table, keyed by directory; anything but a table holds no entries. */
const CodexProjectsTableSchema = z.record(z.string(), z.unknown());

/** A `[projects."<dir>"]` entry; one without a string `trust_level` decides nothing. */
const CodexProjectEntrySchema = z.object({ trust_level: z.string() });

export type CodexProjectTrust =
  | { readonly kind: 'trusted' }
  /** `main`: the main checkout of the repository, which the fix names. */
  | { readonly kind: 'untrusted'; readonly main: string; readonly decidedBy?: { readonly dir: string; readonly level: string } }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * Codex takes the first `projects."<dir>"` entry of `gate.config` holding a
 * `trust_level` for the checkout, then for its workspace root, then for the
 * main checkout of its repository, each keyed by real path; an entry without
 * one decides nothing.
 */
export async function codexProjectTrust(gate: Extract<ReadGate, { kind: 'codex-project-trust' }>): Promise<CodexProjectTrust> {
  const { resolveAnchors } = await import('./utils/git.js');
  const { realFilePath } = await import('./git-exclude.js');
  const root = await realFilePath(gate.checkout);
  const anchors = await resolveAnchors(gate.checkout);
  const main = anchors?.mainCheckout ?? root;
  const dirs = [...new Set([root, anchors?.workspaceRoot ?? root, main])];

  if (!await pathExists(gate.config)) return { kind: 'untrusted', main };
  const raw = await readFileSafe(gate.config);

  if (raw === null) return { kind: 'unreadable', reason: 'could not be read' };
  let projects: unknown;

  try {
    const { parse } = await import('smol-toml');
    projects = parse(withoutTomlBom(raw)).projects;
  } catch (error) {
    return { kind: 'unreadable', reason: `could not be parsed (${error instanceof Error ? error.message.split('\n')[0] : String(error)})` };
  }

  const entries = new Map(Object.entries(CodexProjectsTableSchema.safeParse(projects).data ?? {}));

  for (const dir of dirs) {
    const level = CodexProjectEntrySchema.safeParse(entries.get(dir)).data?.trust_level;

    if (level === undefined) continue;

    return level === 'trusted' ? { kind: 'trusted' } : { kind: 'untrusted', main, decidedBy: { dir, level } };
  }

  return { kind: 'untrusted', main };
}

/** The manual fix for a project Codex does not trust; `cause` opens the sentence and names the resource. */
export function codexTrustFix(trust: Exclude<CodexProjectTrust, { kind: 'trusted' }>, gate: Extract<ReadGate, { kind: 'codex-project-trust' }>, cause: string): string {
  const configFile = gate.config;
  const table = (dir: string): string => `[projects.${JSON.stringify(dir)}]`;

  switch (trust.kind) {
    case 'unreadable':
      return `${cause}, and ${configFile} ${trust.reason}, so whether Codex trusts this checkout is unknown. `
        + `Fix ${configFile}, then run \`teamai doctor\` again.`;
    case 'untrusted':
      if (trust.decidedBy) {
        return `${cause}, and ${configFile} sets trust_level = ${JSON.stringify(trust.decidedBy.level)} in `
          + `${table(trust.decidedBy.dir)}, the entry Codex reads for this checkout. Set it to "trusted".`;
      }

      return `${cause}, and ${configFile} does not trust ${trust.main}. Open Codex in ${trust.main} and trust the project `
        + `when it asks, or add a ${table(trust.main)} table holding trust_level = "trusted" to ${configFile}. `
        + 'Trusting the main checkout covers every worktree of it.';
    default: {
      const unhandled: never = trust;

      return unhandled;
    }
  }
}
