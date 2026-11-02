/**
 * Whether a tool reads what teamai delivered to a project, by the tool's own
 * verdict on that project: its trust, or its approval of the project's MCP
 * servers. `locate` declares each gate (`ReadGate`); this module evaluates
 * it. Read-only: it never grants a verdict.
 */
import type { ReadGate } from './locate.js';
import { codexProjectTrust, codexTrustFix } from './codex-project-trust.js';

/**
 * What teamai holds in the gated place. `summary` opens the fix
 * ("<place> holds team agents (a, b)"), `noun` names the resource, and
 * `names` are the team's items there.
 */
export type Held = { readonly summary: string; readonly noun: string; readonly names: readonly string[] };

export type ReadGateVerdict = { readonly met: true } | { readonly met: false; readonly fix: string };

/** The doctor check's name: what the gate decides for the held resource. */
export function readGateCheckName(gate: ReadGate, noun: string): string {
  switch (gate.kind) {
    case 'codex-project-trust':
      return `Codex trusts this project, so it loads its team ${noun}`;
    default: {
      const unhandled: never = gate.kind;
      return unhandled;
    }
  }
}

export async function readGateVerdict(gate: ReadGate, held: Held): Promise<ReadGateVerdict> {
  switch (gate.kind) {
    case 'codex-project-trust': {
      const trust = await codexProjectTrust(gate);
      return trust.kind === 'trusted'
        ? { met: true }
        : { met: false, fix: codexTrustFix(trust, gate, `${held.summary}, but Codex loads a project's ${held.noun} only in a trusted project`) };
    }
    default: {
      const unhandled: never = gate.kind;
      return unhandled;
    }
  }
}
