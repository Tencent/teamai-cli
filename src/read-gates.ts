/**
 * Whether a tool reads what teamai delivered to a project, by the tool's own
 * verdict on that project: its trust, or its approval of the project's MCP
 * servers. `locate` declares each gate (`ReadGate`); this module evaluates
 * it. Read-only: it never grants a verdict.
 */
import path from 'node:path';
import type { ReadGate } from './locate.js';
import { codexProjectTrust, codexTrustFix } from './codex-project-trust.js';
import { realFilePath } from './git-exclude.js';
import { readJsonObject } from './utils/fs.js';

/**
 * What teamai holds in the gated place. `summary` opens the fix
 * ("<place> holds team agents (a, b)"), `noun` names the resource, and
 * `names` are the team's items there.
 */
export type Held = { readonly summary: string; readonly noun: string; readonly names: readonly string[] };

export type ReadGateVerdict = { readonly met: true } | { readonly met: false; readonly fix: string };

const MET: ReadGateVerdict = { met: true };

/** The doctor check's name: what the gate decides for the held resource. */
export function readGateCheckName(gate: ReadGate, noun: string): string {
  switch (gate.kind) {
    case 'codex-project-trust':
      return `Codex trusts this project, so it loads its team ${noun}`;
    case 'pi-project-trust':
      return `Pi trusts this project, so it loads its team ${noun}`;
    case 'muse-workspace-trust':
      return `Muse Code trusts this project, so it loads its team ${noun}`;
    default: {
      const unhandled: never = gate;
      return unhandled;
    }
  }
}

export async function readGateVerdict(gate: ReadGate, held: Held): Promise<ReadGateVerdict> {
  switch (gate.kind) {
    case 'codex-project-trust': {
      const trust = await codexProjectTrust(gate);
      return trust.kind === 'trusted'
        ? MET
        : { met: false, fix: codexTrustFix(trust, gate, `${held.summary}, but Codex loads a project's ${held.noun} only in a trusted project`) };
    }
    case 'pi-project-trust':
      return piProjectTrust(gate, `${held.summary}, but Pi loads a project's ${held.noun} only in a trusted project`);
    case 'muse-workspace-trust':
      return museWorkspaceTrust(gate, `${held.summary}, but Muse Code loads a project's ${held.noun} only in a trusted workspace`);
    default: {
      const unhandled: never = gate;
      return unhandled;
    }
  }
}

function unreadable(cause: string, file: string, reason: string, tool: string): ReadGateVerdict {
  return {
    met: false,
    fix: `${cause}, and ${file} ${reason}, so whether ${tool} trusts this project is unknown. Fix ${file}, then run \`teamai doctor\` again.`,
  };
}

/** The directory and each one above it, nearest first. */
function upFrom(dir: string): string[] {
  const dirs = [dir];
  for (let parent = path.dirname(dir); parent !== dirs[dirs.length - 1]; parent = path.dirname(parent)) dirs.push(parent);
  return dirs;
}

/**
 * Pi 1.4.0: the nearest `true` or `false` entry of trust.json, walking up from
 * the real path of the directory Pi starts in, decides; with none,
 * `defaultProjectTrust` does ("always", "never", else Pi asks, and `pi -p`
 * takes that as untrusted). A value other than a boolean or null stops Pi.
 */
async function piProjectTrust(gate: Extract<ReadGate, { kind: 'pi-project-trust' }>, cause: string): Promise<ReadGateVerdict> {
  const root = await realFilePath(gate.checkout);
  const trust = await readJsonObject(gate.config);
  if (trust.kind === 'invalid') return unreadable(cause, gate.config, `does not parse (${trust.error})`, 'Pi');
  const entries = trust.kind === 'ok' ? trust.value : {};
  const odd = Object.entries(entries).find(([, value]) => value !== true && value !== false && value !== null);
  if (odd) return unreadable(cause, gate.config, `holds ${JSON.stringify(odd[1])} for ${odd[0]}, where Pi takes true, false or null`, 'Pi');
  const grant = `add ${JSON.stringify(root)}: true to ${gate.config}`;
  for (const dir of upFrom(root)) {
    const value = entries[dir];
    if (value === true) return MET;
    if (value === false) {
      return { met: false, fix: `${cause}, and ${gate.config} sets ${JSON.stringify(dir)}: false, the entry Pi reads for ${root}. Set it to true, or ${grant}.` };
    }
  }
  const settings = await readJsonObject(gate.settings);
  if (settings.kind === 'invalid') return unreadable(cause, gate.settings, `does not parse (${settings.error})`, 'Pi');
  const fallback = settings.kind === 'ok' ? settings.value.defaultProjectTrust : undefined;
  if (fallback === 'always') return MET;
  if (fallback === 'never') {
    return { met: false, fix: `${cause}, and ${gate.settings} sets defaultProjectTrust to "never" while ${gate.config} has no entry for ${root}. To trust this project only, ${grant}.` };
  }
  return {
    met: false,
    fix: `${cause}, and ${gate.config} has no entry for ${root} or a folder above it. Start \`pi\` in ${root} and choose Trust, `
      + `or ${grant}. Until then a headless run (\`pi -p\`) skips them.`,
  };
}

/**
 * Muse Code 1.4.14: the entry for the real path of the checkout's own git
 * root decides, exactly (no parent, and a linked worktree is its own); a store
 * Muse cannot parse fails closed to untrusted. `muse exec` runs an undecided
 * workspace untrusted.
 */
async function museWorkspaceTrust(gate: Extract<ReadGate, { kind: 'muse-workspace-trust' }>, cause: string): Promise<ReadGateVerdict> {
  const { resolveAnchors } = await import('./utils/git.js');
  const target = (await resolveAnchors(gate.checkout))?.workspaceRoot ?? await realFilePath(gate.checkout);
  const grant = `add ${JSON.stringify(target)}: {"decision": "trusted"} under "projects" in ${gate.config}, beside "schema_version": 1`;
  const store = await readJsonObject(gate.config);
  if (store.kind === 'invalid') return unreadable(cause, gate.config, `does not parse (${store.error})`, 'Muse Code');
  if (store.kind === 'ok') {
    const { schema_version: version, projects } = store.value;
    if (version !== 1) return unreadable(cause, gate.config, `has schema_version ${JSON.stringify(version)}, where Muse Code takes 1`, 'Muse Code');
    const entry = typeof projects === 'object' && projects !== null ? Object.entries(projects).find(([dir]) => dir === target)?.[1] : undefined;
    const decision = typeof entry === 'object' && entry !== null && 'decision' in entry ? entry.decision : undefined;
    if (decision === 'trusted') return MET;
    if (decision === 'untrusted') {
      return { met: false, fix: `${cause}, and ${gate.config} records "untrusted" for ${target}, so Muse Code never asks again. Set that decision to "trusted".` };
    }
    if (decision !== undefined) return unreadable(cause, gate.config, `holds the decision ${JSON.stringify(decision)} for ${target}, where Muse Code takes "trusted" or "untrusted"`, 'Muse Code');
  }
  return {
    met: false,
    fix: `${cause}, and ${gate.config} has no decision for ${target}. Start \`muse\` in ${target} and choose "Trust and continue", `
      + `or ${grant}. Each worktree needs its own entry. Until then \`muse exec\` skips them.`,
  };
}
