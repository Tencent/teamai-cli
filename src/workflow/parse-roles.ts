/**
 * Where a workflow file's roles reach a copy. A `defaults.role` or a `workflow` step's `role` is the role of each step
 * inside it that names none (`resolvedRoleOf`), and takes effect where such a step opens a copy: every step continuing
 * that copy runs with the copy's role (`copyOf`). Checked once the file parses, over its steps, its inline workflows
 * and, with `files`, the workflow files they run by name, whose problems are reported at the step that runs them.
 */
import type { Node } from 'yaml';
import { isSeq } from 'yaml';
import { isYamlNode, locate, valueNode, type ParseContext, type WorkflowFiles } from './parse-context.js';
import { stepWorkflow, type WorkflowDefaults, type WorkflowDiagnostic, type WorkflowStep } from './types.js';
import type { StepRoleSpec } from './template.js';
import { cloneOf, copyOf, copyRoleConflict, resolveMode, resolvedRoleOf, roleLevelOf, writtenRole, type RoleLevel, type StepCopy } from './workspace.js';

/** A step on the way to a step: its label, and, in this file, its field and YAML mapping. */
interface Level extends RoleLevel {
  label: string;
  /** Where this file writes the step; undefined for a step of a workflow file it runs by name. */
  written?: { field: string; item: Node | undefined };
  /** Whether the `defaultRole` in effect is this file's own `defaults.role`. */
  isOwnDefaultRole: boolean;
}

/** The `defaults.role` in effect, and whether it is this file's own. */
interface Defaults {
  role?: string;
  isOwn: boolean;
}

/**
 * A workflow file this one runs by name: the step of this file that runs it, by label, the workflows on the way to it,
 * outermost first, and where that step is written.
 */
interface Caller {
  step: string;
  node: Node | undefined;
  field: string;
  runs: readonly string[];
}

/**
 * Which copies take a role: none; only clones that pin a team revision, whose setup checks the role against that
 * revision's `manifest/roles.yaml`; only a copy that a step running this file opens, which that file checks as it walks
 * this one, and a lease checks again; or one that runs with the team pulled now, so its manifest must declare the role.
 */
type RoleTaker = 'none' | 'pinned_clone' | 'enclosing_copy' | 'current_team';

/** A role a step inside may take: this file's `defaults.role` or a `workflow` step's, until a copy runs with it. */
interface RoleSource {
  node: Node | undefined;
  field: string;
  unconsumedMessage: string;
  /** Who names the role, as `undeclaredRole` words it, and its id; none for a template each item's lease renders. */
  owner: string;
  role: string | undefined;
  takenBy: RoleTaker;
}

/** Whether `step` opens a clone of a pinned team revision, whose roles may differ from the team pulled now. */
function opensPinnedClone(step: WorkflowStep): boolean {
  const clone = cloneOf(step);

  return clone !== undefined && 'revision' in clone.team;
}

/**
 * Why `owner`, a step label or `defaults`, may not name `role`: `manifest/roles.yaml` does not declare it. Undefined when
 * it does, or when the sync could not read the manifest, so a lease checks the role then.
 */
function undeclaredRole(owner: string, role: string, files: WorkflowFiles | undefined): string | undefined {
  if (files?.roles === undefined || files.roles.has(role)) return undefined;

  return files.roles.size === 0
    ? `${owner} has role ${role}, which manifest/roles.yaml does not declare; the team repo declares no role, so add it to manifest/roles.yaml or remove role`
    : `${owner} has role ${role}, which manifest/roles.yaml does not declare; add it there, or name a role it declares: ${[...files.roles].join(', ')}`;
}

/** The id a step `role` names as parse reads it, to check against `manifest/roles.yaml`; none for a template, which each item's lease checks. */
function roleIdNamedNow(role: StepRoleSpec): string | undefined {
  switch (role.kind) {
    case 'id': return role.id;
    case 'item_template': return undefined;
    default: {
      const unhandled: never = role;

      return unhandled;
    }
  }
}


/**
 * What a step runs with, as far as this file can tell: a role id, the member's roles, no team, or `unknown`, in a copy
 * whose role a lease renders for its item, or that a step running this file opens.
 */
type RunsWith = { kind: 'role'; role: string } | { kind: 'member' } | { kind: 'no_team' } | { kind: 'unknown' };

/** Whether `role` is known only once each item's lease renders it. */
function rendersPerItem(role: StepRoleSpec | undefined): boolean {
  switch (role?.kind) {
    case undefined:
    case 'id':
      return false;
    case 'item_template':
      return true;
    default: {
      const unhandled: never = role;

      return unhandled;
    }
  }
}

/**
 * A step `step` that resolves `role` but continues the copy step `opener` opens, which runs with `copyRole`, or with
 * none: the role is named by `defaults.role`, by an enclosing `workflow` step, or by the step itself, which may continue
 * a clone.
 */
interface RoleConflict {
  namer: { kind: 'defaults' } | { kind: 'enclosing'; label: string } | { kind: 'itself'; inClone: boolean };
  role: string;
  step: string;
  opener: string;
  copyRole: string | undefined;
}

/**
 * The `bad_role` message of `conflict`: where this file names the role, or, with `caller`, at the step of this file that
 * runs the workflow naming it, through the workflows `caller.runs` lists.
 */
function roleConflictMessage(conflict: RoleConflict, caller?: Caller): string {
  const { namer, role, step, opener, copyRole } = conflict;
  const via = caller?.runs.map((name) => `"${name}"`).join(' > ');

  switch (namer.kind) {
    case 'defaults':
      if (caller) {
        return copyRole === undefined
          ? `${caller.step} runs workflow ${via}, whose defaults.role ${role} is the role of ${step}, but it continues the copy step "${opener}" opens without a role, which every step there runs with; remove defaults.role, or set role ${role} on step "${opener}"`
          : `${caller.step} runs workflow ${via}, whose defaults.role ${role} is the role of ${step}, but it continues the copy step "${opener}" opens with role ${copyRole}, which every step there runs with; remove defaults.role, or set role ${role} on step "${opener}"`;
      }

      return copyRole === undefined
        ? `defaults.role ${role} is the role of ${step}, but it continues the copy step "${opener}" opens without a role, which every step there runs with; remove defaults.role, or set role ${role} on step "${opener}"`
        : `defaults.role ${role} is the role of ${step}, but it continues the copy step "${opener}" opens with role ${copyRole}, which every step there runs with; remove defaults.role, or set role ${role} on step "${opener}"`;
    case 'enclosing':
      if (caller) {
        return copyRole === undefined
          ? `${caller.step} runs workflow ${via}, whose ${namer.label} has role ${role}, but ${step} in it continues the copy step "${opener}" opens without a role, which every step there runs with; remove role from ${namer.label}, or set it on step "${opener}"`
          : `${caller.step} runs workflow ${via}, whose ${namer.label} has role ${role}, but ${step} in it continues the copy step "${opener}" opens with role ${copyRole}, which every step there runs with; remove role from ${namer.label}, or set it on step "${opener}"`;
      }

      return copyRole === undefined
        ? `${namer.label} has role ${role}, but ${step} in it continues the copy step "${opener}" opens without a role, which every step there runs with; remove role from ${namer.label}, or set it on step "${opener}"`
        : `${namer.label} has role ${role}, but ${step} in it continues the copy step "${opener}" opens with role ${copyRole}, which every step there runs with; remove role from ${namer.label}, or set it on step "${opener}"`;
    case 'itself':
      if (namer.inClone) {
        return caller
          ? `${caller.step} runs workflow ${via}, whose ${step} has role ${role} but continues a clone, which runs with the role of the step that opens it; set role on that step`
          : `${step} has role ${role} but continues a clone, which runs with the role of the step that opens it; set role on that step`;
      }

      if (caller) {
        return copyRole === undefined
          ? `${caller.step} runs workflow ${via}, whose ${step} has role ${role} but continues the copy step "${opener}" opens without a role, which every step there runs with; remove role from ${step}, or set it on step "${opener}"`
          : `${caller.step} runs workflow ${via}, whose ${step} has role ${role} but continues the copy step "${opener}" opens with role ${copyRole}, which every step there runs with; remove role from ${step}, or set it on step "${opener}"`;
      }

      return copyRole === undefined
        ? `${step} has role ${role} but continues the copy step "${opener}" opens without a role, which every step there runs with; remove role from ${step}, or set it on step "${opener}"`
        : `${step} has role ${role} but continues the copy step "${opener}" opens with role ${copyRole}, which every step there runs with; remove role from ${step}, or set it on step "${opener}"`;
    default: {
      const unhandled: never = namer;

      return unhandled;
    }
  }
}

/** The `bad_role` and `bad_session` diagnostics of the roles of `workflow`, the file whose YAML mapping is `root`. */
export function roleDiagnostics(root: Node, workflow: { defaults?: WorkflowDefaults; steps: readonly WorkflowStep[] }, ctx: ParseContext): WorkflowDiagnostic[] {
  const { file, lineCounter } = ctx;
  const diagnostics: WorkflowDiagnostic[] = [];
  const reported = new Set<string>();

  const report = (code: 'bad_role' | 'bad_session', node: Node | undefined, field: string, message: string): void => {
    if (reported.has(`${field}\n${message}`)) return;
    reported.add(`${field}\n${message}`);
    diagnostics.push({ ...locate(file, lineCounter, node, field, message), code });
  };

  const sources = new Map<string, RoleSource>();
  const defaultRole = workflow.defaults?.role;

  if (defaultRole !== undefined) {
    sources.set('defaults.role', {
      node: valueNode(valueNode(root, 'defaults'), 'role'), field: 'defaults.role', owner: 'defaults', role: defaultRole, takenBy: 'none',
      unconsumedMessage: `defaults.role ${defaultRole} is the role of no step: no step that names no role of its own opens or continues a copy, so none runs with it; give such a step workspace: new, or remove defaults.role`,
    });
  }

  /** Marks the source of the role `levels` resolve as taken by a copy, which `by` runs with. */
  const consume = (levels: readonly Level[], by: Exclude<RoleTaker, 'none'>): void => {
    const resolved = resolvedRoleOf(levels);

    if (resolved === undefined) return;
    const level = resolved.from === 'defaults' ? undefined : levels[resolved.from];
    const key = resolved.from === 'defaults' ? (levels.at(-1)?.isOwnDefaultRole ? 'defaults.role' : undefined) : level?.written && `${level.written.field}.role`;
    const source = key === undefined ? undefined : sources.get(key);

    if (source && source.takenBy !== 'current_team') source.takenBy = by;
  };

  /**
   * What a step runs with, as `levels` reach it, or `unknown` in a copy that a step running this file opens, or that runs
   * with a role template, which each item's lease renders.
   */
  const runsWith = (levels: readonly Level[]): RunsWith => {
    const copy = copyOf(levels);
    const last = levels.at(-1);

    if (!copy) return last && resolveMode(last.step, levels.slice(0, -1).map((level) => level.step)) === 'continue' ? { kind: 'unknown' } : { kind: 'member' };

    switch (copy.runsWith.kind) {
      case 'member':
      case 'no_team':
        return copy.runsWith;
      case 'role': {
        const { role } = copy.runsWith;

        switch (role.kind) {
          case 'id': return { kind: 'role', role: role.id };
          case 'item_template': return { kind: 'unknown' };
          default: {
            const unhandled: never = role;

            return unhandled;
          }
        }
      }

      default: {
        const unhandled: never = copy.runsWith;

        return unhandled;
      }
    }
  };

  /**
   * Reports that the last of `levels` resolves a role other than the one of the copy `copy`, which an enclosing step
   * opened: where this file names that role, else at the step of this file that runs the workflow naming it.
   */
  const conflictAt = (levels: readonly Level[], copy: StepCopy, caller: Caller | undefined): void => {
    const resolved = resolvedRoleOf(levels);
    const last = levels.at(-1);
    const opener = levels[copy.opener];

    // A copy that a workflow this file runs opens is that file's to check.
    if (!last || !opener?.written || resolved === undefined) return;
    const named = resolved.from === 'defaults' ? undefined : levels[resolved.from];

    const conflict: RoleConflict = {
      namer: resolved.from === 'defaults' ? { kind: 'defaults' } : named && named !== last ? { kind: 'enclosing', label: named.label } : { kind: 'itself', inClone: cloneOf(opener.step) !== undefined },
      role: writtenRole(resolved.role), step: last.label, opener: opener.step.id,
      copyRole: copy.runsWith.kind === 'role' ? writtenRole(copy.runsWith.role) : undefined,
    };

    const own = resolved.from === 'defaults' ? (last.isOwnDefaultRole ? sources.get('defaults.role') : undefined)
      : named?.written && { node: valueNode(named.written.item, 'role'), field: `${named.written.field}.role` };

    // Setting the role on the opener helps only once the team pulled now declares it; a pinned clone checks its own revision.
    const id = roleIdNamedNow(resolved.role);
    const declared = ctx.files?.roles;

    const declareFirst = id !== undefined && declared !== undefined && !declared.has(id) && !opensPinnedClone(opener.step)
      ? ` once manifest/roles.yaml declares ${id}, which it does not: it declares ${declared.size === 0 ? 'no role' : [...declared].join(', ')}`
      : '';

    if (own) report('bad_role', own.node, own.field, `${roleConflictMessage(conflict)}${declareFirst}`);
    else if (caller) report('bad_role', caller.node, caller.field, `${roleConflictMessage(conflict, caller)}${declareFirst}`);
  };

  /**
   * Reports the role id `level` names itself when a copy that runs with the team pulled now takes it and that team's
   * manifest/roles.yaml does not declare it. A pinned clone's setup checks it at the clone's revision instead, and a
   * copy a step running this file opens is checked where that step is.
   */
  const ownRoleDeclared = (level: Level, by: Exclude<RoleTaker, 'none'>): void => {
    const id = level.role && roleIdNamedNow(level.role);

    if (by !== 'current_team' || !level.written || id === undefined) return;
    const undeclared = undeclaredRole(level.label, id, ctx.files);

    if (undeclared !== undefined) report('bad_role', valueNode(level.written.item, 'role'), `${level.written.field}.role`, undeclared);
  };

  /** A step that runs no workflow: where its role reaches, and what it takes. */
  const leaf = (levels: readonly Level[], caller: Caller | undefined): void => {
    const last = levels.at(-1);

    if (!last) return;
    const copy = copyOf(levels);

    if (!copy) {
      if (runsWith(levels).kind === 'unknown') {
        // The copy this step continues is opened by a step of a workflow that runs this file, whose walk checks its role;
        // with no such workflow, it can only be one that runs with the team pulled now.
        const by = ctx.files?.isRunByName ? 'enclosing_copy' : 'current_team';
        consume(levels, by);
        ownRoleDeclared(last, by);
      } else if (last.step.role !== undefined && last.written) {
        report('bad_role', valueNode(last.written.item, 'role'), `${last.written.field}.role`, `${last.label} has role ${last.step.role} but neither opens nor continues a copy; give the prompt step workspace: new to open a copy that runs with the role, or workspace: continue to run with it in the copy around it`);
      }

      return;
    }

    if (copy.runsWith.kind === 'no_team') {
      if (last.step.role !== undefined && copy.opener !== levels.length - 1 && last.written) {
        report('bad_role', valueNode(last.written.item, 'role'), `${last.written.field}.role`, `${last.label} has role ${last.step.role} but continues a clone, which runs with the role of the step that opens it; set role on that step`);
      }

      return;
    }

    // The copy runs with its opener's role whatever a step there resolves, and a conflict is reported once, as such.
    const opener = levels[copy.opener];
    const by = opener && opensPinnedClone(opener.step) ? 'pinned_clone' : 'current_team';
    consume(levels, by);
    consume(levels.slice(0, copy.opener + 1), by);
    // Whether a role template agrees with the copy's is known once a lease renders it for an item.
    const templated = rendersPerItem(resolvedRoleOf(levels)?.role) || rendersPerItem(copy.runsWith.kind === 'role' ? copy.runsWith.role : undefined);

    if (!templated && copyRoleConflict(levels)) conflictAt(levels, copy, caller);
    else ownRoleDeclared(last, by);
  };

  /**
   * The step `levels` end at resumes the session of `from`, a step before it, which must run with the same role, as
   * `sessionOf` checks at lease: a step in a clone without a team, as one outside any copy, runs with no step role.
   */
  const session = (levels: readonly Level[], from: readonly Level[], fromId: string): void => {
    const last = levels.at(-1);
    const own = runsWith(levels);
    const theirs = runsWith(from);

    if (!last?.written || own.kind === 'unknown' || theirs.kind === 'unknown') return;
    const roleOf = (runs: Exclude<RunsWith, { kind: 'unknown' }>): string | undefined => (runs.kind === 'role' ? runs.role : undefined);

    if (roleOf(own) === roleOf(theirs)) return;
    const named = (role: string | undefined): string => (role === undefined ? 'your roles' : `role ${role}`);
    report('bad_session', valueNode(valueNode(last.written.item, 'session'), 'from'), `${last.written.field}.session.from`,
      `${last.label} session.from names "${fromId}", which runs with ${named(roleOf(theirs))}, while ${last.label} runs with ${named(roleOf(own))}; a session goes on only with the knowledge it started with, so run both steps with one role, or start a new session`);
  };

  const walk = (steps: readonly WorkflowStep[], input: {
    node: Node | undefined; at: string; outer: readonly Level[]; defaults: Defaults; caller: Caller | undefined;
    around?: { steps: readonly WorkflowStep[]; outer: readonly Level[]; levelOf: (step: WorkflowStep) => Level };
  }): void => {
    const { node, at, outer, defaults, caller } = input;

    const levelOf = (step: WorkflowStep, index: number): Level => {
      const item: unknown = isSeq(node) ? node.items[index] : undefined;

      const level: Level = { ...roleLevelOf(step, defaults.role), label: `step "${step.id}"`, isOwnDefaultRole: defaults.isOwn };

      if (!caller) level.written = { field: `${at}steps[${index}]`, item: isYamlNode(item) ? item : undefined };

      return level;
    };

    steps.forEach((step, index) => {
      const level = levelOf(step, index);
      const levels = [...outer, level];
      const runs = stepWorkflow(step);

      if (step.role !== undefined && runs !== undefined && level.written) {
        sources.set(`${level.written.field}.role`, {
          node: valueNode(level.written.item, 'role'), field: `${level.written.field}.role`, owner: level.label, role: level.role && roleIdNamedNow(level.role), takenBy: 'none',
          unconsumedMessage: `${level.label} has role ${step.role}, but no step in it that names no role of its own opens or continues a copy, so none runs with it; give such a step workspace: new, or remove role`,
        });
      }

      switch (runs?.kind) {
        case undefined:
          leaf(levels, caller);
          break;
        case 'inline':
          walk(runs.workflow.steps, {
            node: valueNode(valueNode(level.written?.item, 'workflow'), 'steps'), at: `${at}steps[${index}].workflow.`, outer: levels, defaults, caller,
            around: { steps, outer, levelOf: (around) => levelOf(around, steps.indexOf(around)) },
          });
          break;
        case 'named': {
          const child = caller?.runs.includes(runs.name) ? null : ctx.files?.runnable(runs.name) ?? null;

          // A workflow this sync cannot read takes the role, as far as this file can tell; its lease checks it.
          if (!child) consume(levels, 'current_team');
          else {
            walk(child.steps, {
              node: undefined, at: '', outer: levels, defaults: child.defaults?.role !== undefined ? { role: child.defaults.role, isOwn: false } : defaults,
              caller: {
                step: caller?.step ?? level.label, node: caller?.node ?? valueNode(level.written?.item, 'workflow'),
                field: caller?.field ?? `${level.written?.field ?? at}.workflow`, runs: [...caller?.runs ?? [], runs.name],
              },
            });
          }

          break;
        }

        case 'from':
          // A workflow a step outputs is admitted when it reports; its lease checks the role then.
          consume(levels, 'current_team');
          break;
        default: {
          const unhandled: never = runs;
          void unhandled;
        }
      }

      if (caller || step.session === undefined || !('from' in step.session)) return;
      const fromId = step.session.from;
      const sibling = steps.find((other) => other.id === fromId);
      const enclosing = sibling ? undefined : input.around?.steps.find((other) => other.id === fromId);

      if (sibling) session(levels, [...outer, levelOf(sibling, steps.indexOf(sibling))], fromId);
      else if (enclosing && input.around) session(levels, [...input.around.outer, input.around.levelOf(enclosing)], fromId);
    });
  };

  walk(workflow.steps, { node: valueNode(root, 'steps'), at: '', outer: [], defaults: { role: defaultRole, isOwn: true }, caller: undefined });

  for (const source of sources.values()) {
    const undeclared = source.role === undefined ? undefined : undeclaredRole(source.owner, source.role, ctx.files);

    switch (source.takenBy) {
      case 'none':
        report('bad_role', source.node, source.field, source.unconsumedMessage);
        break;
      case 'pinned_clone':
      case 'enclosing_copy':
        break;
      case 'current_team':
        if (undeclared !== undefined) report('bad_role', source.node, source.field, undeclared);
        break;
      default: {
        const unhandled: never = source.takenBy;
        void unhandled;
      }
    }
  }

  return diagnostics;
}
