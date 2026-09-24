import path from 'node:path';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { expandHome, listFilesRecursive, pathExists, readFileSafe } from './utils/fs.js';
import { getDataHome, getMcpSharing, isAgentExcluded } from './types.js';
import type { DeliveryTarget, ResourceItem } from './types.js';
import { splitFrontmatter } from './utils/frontmatter.js';
import type { ResourceHandler } from './resources/base.js';
import type { Check, DoctorContext } from './doctor.js';
import {
  extractEnvBlock,
  envBlockSourcesPath,
  envBlockReferencesDataHome,
  sameFile,
  SHELL_PROFILE_CANDIDATE_NAMES,
} from './utils/shell-profile.js';
import { getUserHome } from './utils/home.js';

/**
 * The checks that verify the payload rather than the plumbing: what each tool
 * was owed, against what is on its disk (#598, #624).
 *
 * They live beside `doctor.ts` rather than inside it because every one of them
 * is domain logic — where a rule lands for Cursor, which tools an agent's spec
 * targets, whether a shell block would load — and `doctor.ts` is the registry
 * that runs them.
 *
 * Every check here is read-only by contract. `doctor-delivery.test.ts` asserts
 * it directly: resolving a destination must never write, or the command whose
 * job is to describe the machine would change it.
 */

/**
 * Whether a delivered skill directory is one an agent can actually discover:
 * SKILL.md present, frontmatter parses, and its `name` is the directory's own.
 * A copy that fails this landed successfully — no write-time gate can see it.
 */
async function skillIsDiscoverable(skillDir: string, skillName: string): Promise<boolean> {
  const content = await readFileSafe(path.join(skillDir, 'SKILL.md'));
  if (!content) return false;

  const { data, valid } = splitFrontmatter(content);
  if (!valid) return false;
  return data.name === skillName;
}

/**
 * Whether `filePath` is a file something can actually read. `pathExists`
 * follows symlinks but says yes to a directory too, so on its own it cannot
 * tell a delivered document from a name occupied by something else.
 */
async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(expandHome(filePath))).isFile();
  } catch {
    return false;
  }
}

/** At most this many names in a fix string; the rest are counted. */
const MAX_NAMED_IN_FIX = 5;

/** Group item names under the tool that did not receive them. */
function appendTo(buckets: Map<string, string[]>, tool: string, name: string): void {
  const names = buckets.get(tool);
  if (names) names.push(name);
  else buckets.set(tool, [name]);
}

/** What one tool was owed, and which of it did not arrive intact. */
interface ToolDelivery {
  /** Where its items land — the fix names it when the filename is derived. */
  dir: string;
  /** Item names grouped by the problem label `classify` gave them. */
  problems: Map<string, string[]>;
}

/**
 * Walk every desired item across the tools that receive it, letting `classify`
 * name what is wrong with each delivered path, or return null when it arrived
 * intact. A tool absent from every item's targets receives nothing, so nothing
 * is owed: it is either uninstalled — caught by its own `<tool> is installed`
 * check — or configured without a path for this resource.
 */
async function walkDelivery(
  handler: ResourceHandler,
  ctx: DoctorContext,
  items: ResourceItem[],
  classify: (target: DeliveryTarget, item: ResourceItem) => Promise<string | null>,
): Promise<{ byTool: Map<string, ToolDelivery>; unreceived: string[] }> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return { byTool: new Map(), unreceived: [] };

  const byTool = new Map<string, ToolDelivery>();
  const unreceived: string[] = [];

  for (const item of items) {
    const targets = await handler.deliveryTargets(teamConfig, localConfig, item);
    if (targets.length === 0) unreceived.push(item.name);

    for (const target of targets) {
      let delivery = byTool.get(target.tool);
      if (!delivery) {
        delivery = { dir: path.dirname(target.dest), problems: new Map() };
        byTool.set(target.tool, delivery);
      }
      const problem = await classify(target, item);
      if (problem !== null) appendTo(delivery.problems, problem, item.name);
    }
  }

  return { byTool, unreceived };
}

/**
 * `not delivered: a, b; unreadable: c`, with the labels in the order the caller
 * lists them rather than the order the failures happened, so the same broken
 * machine reads the same way twice.
 */
function describeProblems(problems: Map<string, string[]>, labels: readonly string[]): string {
  return labels
    .filter((label) => (problems.get(label)?.length ?? 0) > 0)
    .map((label) => `${label}: ${nameList(problems.get(label) ?? [])}`)
    .join('; ');
}

/** `a, b, c and 4 more` — a fix a human reads, not a wall of paths. */
function nameList(names: string[]): string {
  if (names.length <= MAX_NAMED_IN_FIX) return names.join(', ');
  const shown = names.slice(0, MAX_NAMED_IN_FIX).join(', ');
  return `${shown} and ${names.length - MAX_NAMED_IN_FIX} more`;
}

/**
 * Build one delivery check per installed tool: every skill the member should
 * have, against what is actually on disk for that tool.
 *
 * This is the only check that looks at the payload rather than the plumbing. A
 * write-time gate cannot cover it — `SkillsHandler.pullItem` skips each
 * uninstalled tool on its own, and a directory deleted by hand after a correct
 * pull leaves every gate happy (#598).
 *
 * The scan runs here rather than inside `check()` because the fix names the
 * skills that are missing, and a `Check`'s fix is read as it was built.
 */
export async function buildDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  // Dynamic: pull.ts imports this module for its post-pull pass, and the desired
  // set is policy that must not be restated here.
  const { buildRolePullContext, resolveDesiredSkills } = await import('./pull.js');
  const { getHandler } = await import('./resources/index.js');

  let items: ResourceItem[];
  try {
    const roleContext = await buildRolePullContext(localConfig);
    ({ items } = await resolveDesiredSkills(teamConfig, localConfig, roleContext));
  } catch (e) {
    // A team repo whose active namespaces collide cannot say what should be
    // delivered — `pull` aborts the scope with this same message. The command
    // whose job is explaining bad state must report it, not stack-trace on it.
    return [{
      name: 'Skills to deliver can be resolved',
      source: 'local',
      check: async () => false,
      fix: `${(e as Error).message}. Until the team repo is fixed, `
        + 'pull cannot sync skills for this role.',
    }];
  }
  if (items.length === 0) return [];

  const labels = ['not delivered', 'delivered but unreadable'] as const;
  const { byTool } = await walkDelivery(getHandler('skills'), ctx, items, async ({ dest }, item) => {
    if (!await pathExists(dest)) return labels[0];
    return await skillIsDiscoverable(dest, item.name) ? null : labels[1];
  });

  return [...byTool].map(([tool, delivery]) => ({
    name: `Skills delivered to ${tool}`,
    source: 'local',
    check: async () => delivery.problems.size === 0,
    fix: `In ${tool}, ${describeProblems(delivery.problems, labels)}. Run \`teamai pull --force\`: `
      + 'a plain pull skips a scope whose team repo has not changed, so it cannot restore this. '
      + 'If a skill stays unreadable, fix its SKILL.md in the team repo — the '
      + 'frontmatter needs a `name` matching the directory, or the agent never '
      + 'discovers it.',
  }));
}

/**
 * Build one delivery check per tool that receives rules: every rule the member
 * should have, against what is on disk for that tool.
 *
 * Rules change filename *and* content per tool, so only the handler can say
 * where one lands. Asking it here is what keeps the check from growing its own
 * copy of the extension table (#624).
 */
export async function buildRulesDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { buildRolePullContext, resolveDesiredRules } = await import('./pull.js');
  const { getHandler } = await import('./resources/index.js');

  const roleContext = await buildRolePullContext(localConfig);
  const { items } = await resolveDesiredRules(teamConfig, localConfig, roleContext);
  if (items.length === 0) return [];

  const activation = await buildRulesActivationChecks(ctx, items);

  // `pullItem` writes the handler's render byte for byte, so anything else at
  // that path is a stale or hand-edited copy. Cursor reads `globs` and
  // `alwaysApply` and Copilot reads `applyTo`; comparing against the render
  // catches a wrong value there, which checking the keys were present did not.
  const ruleLabels = ['not delivered', 'delivered from an older copy'] as const;
  const perTool: Check[] = [...(await walkDelivery(
    getHandler('rules'),
    ctx,
    items,
    async ({ dest, content }) => {
      // readFileSafe answers both questions at once: a directory or a dangling
      // link on the name reads as null, the same as nothing being there.
      const delivered = await readFileSafe(dest);
      if (delivered === null) return ruleLabels[0];
      return content === undefined || delivered === content ? null : ruleLabels[1];
    },
  )).byTool].map(([tool, delivery]) => ({
    name: `Rules delivered to ${tool}`,
    source: 'local',
    check: async () => delivery.problems.size === 0,
    // The fix names the directory rather than the tool: a rule's delivered
    // filename carries a per-tool extension the reader would have to derive.
    fix: `In ${delivery.dir}, ${describeProblems(delivery.problems, ruleLabels)}. `
      + 'Run `teamai pull --force`: a plain pull skips a scope whose team repo has not changed, '
      + 'so it cannot restore this. An older copy is one whose bytes are no longer what teamai '
      + `renders for ${tool}, frontmatter included: a \`.mdc\` or \`.instructions.md\` whose `
      + '`globs`, `alwaysApply` or `applyTo` drifted from the team `.md` applies to the wrong '
      + 'files while looking perfectly well-formed.',
  }));

  return [...activation, ...perTool];
}

/**
 * The two rule destinations that are not a file per tool.
 *
 * OpenCode does not auto-scan its rules directory: a `.md` copied there is
 * inert until `opencode.json` references it through the glob the pull owns.
 * Hermes has no rules directory at all — its rules are inlined into a managed
 * block of SOUL.md. Both are delivered by `pullAllRules` rather than by
 * `pullItem`, so `deliveryTargets` cannot see them, and a per-file check
 * passes over a tool that reads none of what it was given.
 *
 * They take the shape of the hook and MCP checks — one destination, not one
 * per tool — rather than an invented entry in `deliveryTargets`.
 */
async function buildRulesActivationChecks(ctx: DoctorContext, items: ResourceItem[]): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { RulesHandler, hermesRulesText } = await import('./resources/rules.js');
  const handler = new RulesHandler();
  const checks: Check[] = [];

  const opencode = await handler.opencodeInstructionsTarget(teamConfig, localConfig);
  if (opencode !== null) {
    const instructions = await readOpencodeInstructions(opencode.configFile);
    const active = instructions !== null && instructions.includes(opencode.glob);
    checks.push({
      name: 'Team rules are active in opencode',
      source: 'local',
      check: async () => active,
      fix: instructions === null
        ? `${opencode.configFile} could not be read as a JSON object, so the pull left it alone `
          + `and never added \`${opencode.glob}\` to \`instructions\`. Fix the file, then run `
          + '`teamai pull --force`.'
        : `${opencode.configFile} does not list \`${opencode.glob}\` under \`instructions\`. `
          + 'OpenCode does not scan a rules directory, so every team rule delivered there is '
          + 'inert until this glob references it. Run `teamai pull --force`: a plain pull skips '
          + 'a scope whose team repo has not changed, so it cannot restore this.',
    });
  }

  const { getHermesHome } = await import('./hermes-home.js');
  const hermesHome = getHermesHome();
  if (!isAgentExcluded(localConfig, 'hermes') && await pathExists(hermesHome)) {
    const { getHermesSoulPath, readSoulRules } = await import('./hermes-config.js');
    const expected = await hermesRulesText(items);
    const delivered = await readSoulRules();
    checks.push({
      name: 'Team rules are inlined in Hermes SOUL.md',
      source: 'local',
      check: async () => delivered !== null && delivered === expected.trim(),
      fix: delivered === null
        ? `${getHermesSoulPath()} carries no teamai rules block, so Hermes reads none of the `
          + 'team rules. Run `teamai pull --force`: a plain pull skips a scope whose team repo '
          + 'has not changed, so it cannot restore this.'
        : `The teamai block in ${getHermesSoulPath()} is not what the team rules inline to: `
          + 'Hermes reads standing instructions from this file rather than a rules directory, '
          + 'so a stale block is a stale rule set. Run `teamai pull --force` to rewrite it.',
    });
  }

  return checks;
}

/**
 * The `instructions` entries of an opencode.json, or null when the file is
 * missing or is not a JSON object — the two cases in which the pull leaves it
 * strictly alone and the glob never lands.
 */
async function readOpencodeInstructions(configFile: string): Promise<unknown[] | null> {
  const raw = await readFileSafe(configFile);
  if (raw === null) return null;
  if (raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const { instructions } = parsed as { instructions?: unknown };
    return Array.isArray(instructions) ? instructions : [];
  } catch {
    return null;
  }
}

/**
 * Build one delivery check per tool that receives agents.
 *
 * An agent's desired set is a relation rather than a product: `spec.targets`
 * names the tools it is for, and each renders into its own format, so the
 * handler is the only thing that can say which tools owe what file (#624).
 */
export async function buildAgentsDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { buildRolePullContext, resolveDesiredAgents } = await import('./pull.js');
  const { AgentsHandler } = await import('./resources/agents.js');
  const handler = new AgentsHandler();

  let items: ResourceItem[];
  try {
    const roleContext = await buildRolePullContext(localConfig);
    items = await resolveDesiredAgents(teamConfig, localConfig, roleContext);
  } catch (e) {
    // Two active namespaces claiming one agent name: `pull` aborts the scope
    // with this message rather than picking one, so `doctor` reports it.
    return [{
      name: 'Agents to deliver can be resolved',
      source: 'local',
      check: async () => false,
      fix: `${(e as Error).message}. Until the team repo is fixed, `
        + 'pull cannot sync agents for this role.',
    }];
  }
  if (items.length === 0) return [];

  // An agent whose spec reaches no tool at all is not a per-tool failure: the
  // file is in the team repo and nothing renders it anywhere.
  const agentLabels = ['not delivered', 'delivered from an older spec'] as const;
  const { byTool, unreceived: unreachable } = await walkDelivery(
    handler,
    ctx,
    items,
    // `pullItem` writes `content` verbatim, so anything else at that path is a
    // render of an older spec — a copy that landed and is still wrong, the
    // same class as a rule whose delivered copy no longer matches its render.
    async ({ dest, content }) => {
      // readFileSafe answers both questions at once: a directory or a dangling
      // link on the name reads as null, the same as nothing being there.
      const delivered = await readFileSafe(dest);
      if (delivered === null) return agentLabels[0];
      return content === undefined || delivered === content ? null : agentLabels[1];
    },
  );

  const checks: Check[] = [...byTool].map(([tool, delivery]) => ({
    name: `Agents delivered to ${tool}`,
    source: 'local',
    check: async () => delivery.problems.size === 0,
    fix: `In ${delivery.dir}, ${describeProblems(delivery.problems, agentLabels)}. `
      + 'Run `teamai pull --force`: a plain pull skips a scope whose team repo has not changed, '
      + 'so it cannot restore this.',
  }));

  // Only worth reporting once a tool is there to receive agents: with none
  // installed, "reaches no tool" is the machine, not the team repo. The gate is
  // the installed tools rather than the deliveries, or a set of agents that all
  // fail to render would report nothing at all.
  const agentTools = await handler.agentToolDirs(teamConfig, localConfig);
  if (unreachable.length > 0 && agentTools.length > 0) {
    checks.push({
      name: 'Every team agent reaches a tool',
      source: 'local',
      check: async () => false,
      fix: `${nameList(unreachable)} render for no installed tool. Either the spec does not `
        + 'parse — `teamai pull` names the reason — or its `targets:` lists only tools that '
        + 'are not installed here.',
    });
  }

  return checks;
}

/**
 * Build one check per tool that receives MCP servers.
 *
 * An MCP server is an entry inside the tool's own config file, not a file of
 * its own, so this takes the shape of the hook check rather than of
 * `deliveryTargets`. It reports two things a pull says once and never again:
 * a desired server whose entry is not there, and a server the reconcile
 * skipped — an unresolved `${VAR}` is the reason behind "MCP does not work"
 * that no other output points at (#662).
 */
export async function buildMcpDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];
  // HTTP-backed teams have no repo tree: servers arrive through the local-agent
  // install channel, and the desired set here would always be empty.
  if (localConfig.repo.kind === 'http') return [];

  const sharing = getMcpSharing(teamConfig);
  // Nothing was promised automatically, so nothing is owed until the member
  // runs `teamai mcp inject`.
  if (!sharing.autoApply) return [];

  const {
    resolveMcpTargets, buildDesiredMcpContext, desiredMcpForTarget,
    mcpTargetExcluded, installedMcpEntries,
  } = await import('./mcp-reconcile.js');
  const { readMcpYaml, teamMcpToDef, teamMcpYamlPath } = await import('./resources/mcp.js');

  // A file that does not parse is not a team without MCP: the pull logs the
  // reason once and injects nothing anywhere, and every later run is silent.
  // Flattening it to an empty desired set is what let `doctor --json` answer
  // `ok: true` over a team whose MCP reaches no tool at all.
  const read = await readMcpYaml(localConfig.repo.localPath);
  if (!read.ok) {
    const yamlPath = teamMcpYamlPath(localConfig.repo.localPath);
    return [{
      name: 'Team MCP servers can be read',
      source: 'local',
      check: async () => false,
      fix: `${yamlPath} does not parse: ${read.reason}. No server is injected into any tool `
        + 'until it is fixed in the team repo and pushed.',
    }];
  }

  const teamDefs = (read.yaml?.servers ?? []).map(teamMcpToDef);
  if (teamDefs.length === 0) return [];

  const targets = await resolveMcpTargets(teamConfig, localConfig);
  const desiredContext = await buildDesiredMcpContext(teamConfig, localConfig);
  const excludedByUser = new Set(localConfig.excludedSkills ?? []);

  const checks: Check[] = [];
  for (const target of targets) {
    if (mcpTargetExcluded(localConfig, target)) continue;

    const { desired, skipped } = desiredMcpForTarget(target, teamDefs, desiredContext);
    const blocked = skipped
      .filter((change) => !excludedByUser.has(change.server))
      .map((change) => `${change.server} (${change.reason ?? 'skipped'})`);

    const problems: string[] = [];
    const installed = await installedMcpEntries(target);
    if (installed === null) {
      problems.push(`${target.file} could not be parsed, so no server was injected`);
    } else {
      const absent: string[] = [];
      const foreign: string[] = [];
      for (const [name, { entry }] of desired) {
        if (!installed.has(name)) absent.push(name);
        // An entry that is not the one teamai renders is not this server: the
        // appliers leave an entry they do not own alone, so the name can be
        // held by something else entirely, and a stale copy is equally undelivered.
        else if (!isDeepStrictEqual(installed.get(name), entry)) foreign.push(name);
      }
      if (absent.length > 0) problems.push(`not injected: ${nameList(absent)}`);
      if (foreign.length > 0) problems.push(`not the team's definition: ${nameList(foreign)}`);
    }
    if (blocked.length > 0) problems.push(`skipped: ${nameList(blocked)}`);

    if (problems.length === 0 && desired.size === 0) continue;

    checks.push({
      name: `MCP servers delivered to ${target.tool}`,
      source: 'local',
      check: async () => problems.length === 0,
      fix: `In ${target.file}, ${problems.join('; ')}. A server needing a variable reads it from `
        + '`env/env.yaml`, whose top-level key is `variables:` — a plain `KEY: value` mapping '
        + 'parses as no variables at all. Then run `teamai pull --force`: a pull leaves an entry '
        + 'teamai does not own untouched, so a server of your own under a team name only gives '
        + 'way to `--force`.',
    });
  }

  return checks;
}

/**
 * Check that the env variables the team declares actually reach a shell.
 *
 * The plumbing version of this check asked only whether the marker comment was
 * in the profile, which is true of a block that cannot load and of a run that
 * delivered nothing. Both failures surface three layers away, as MCP servers
 * skipped for `unresolved variable(s)`, with nothing pointing back here.
 */
export async function buildEnvDeliveryCheck(ctx: DoctorContext): Promise<Check[]> {
  const { problems, staleProfiles } = await envDeliveryProblems(ctx);
  return [
    {
      name: 'Env variables injected in shell profile',
      source: 'local',
      check: async () => problems.length === 0,
      fix: problems.length === 0
        ? 'Run `teamai pull` to inject env variables into shell profile'
        : `${problems.join('; ')}. Run \`teamai pull\` after fixing the cause, then open a new shell.`,
    },
    // A separate check, not folded into the one above: a stray leftover
    // block for this same scope (e.g. from before #682 changed which file
    // `pull` prefers) is dead weight, not a delivery failure — the variables
    // are reaching a shell just fine through the resolved profile. Reporting
    // it as the SAME failure as "your env vars aren't reaching a shell"
    // would tell a user whose delivery genuinely works that it is broken
    // (#693 review round 5).
    {
      name: 'No stale env blocks left behind',
      source: 'local',
      informational: true,
      check: async () => staleProfiles.length === 0,
      fix: staleProfiles.length === 0
        ? undefined
        : `${nameList(staleProfiles)} still carries a teamai env block for this scope from an `
          + 'earlier install; run `teamai uninstall` to remove it, or delete the block manually.',
    },
  ];
}

/** Every reason the team's env variables are not reaching a shell, and any stray leftover blocks found along the way. */
async function envDeliveryProblems(
  ctx: DoctorContext,
): Promise<{ problems: string[]; staleProfiles: string[] }> {
  const { localConfig, teamConfig } = ctx;
  const none = { problems: [], staleProfiles: [] };
  if (teamConfig?.sharing?.env?.injectShellProfile === false) return none;

  const envYamlPath = path.join(localConfig.repo.localPath, 'env', 'env.yaml');
  if (!await pathExists(envYamlPath)) return none;

  const { EnvHandler } = await import('./resources/env.js');
  const envHandler = new EnvHandler();

  // The handler distinguishes a file that parses from one that does not, so a
  // shorthand `KEY: value` mapping is reported (#662) while a deliberate
  // `variables: []` is not. Counting the variables alone cannot tell them apart.
  const read = await envHandler.readEnvYaml(envYamlPath);
  if (!read.ok) return { problems: [read.reason], staleProfiles: [] };

  // Only the variables this member and directory are scoped to: the same filter
  // `pullItem` applies, not a second copy of it. Diffing env.sh against every
  // DECLARED variable would report a project-scoped one as undelivered on a pull
  // that correctly withheld it.
  const { resolveDeliverableEnvVariables } = await import('./resources/env.js');
  const { resolveMembership } = await import('./membership.js');
  const declared = resolveDeliverableEnvVariables(read.variables, resolveMembership(localConfig));
  // The variables the filter withheld. `pull` rewrites env.sh from the
  // deliverable set, so one of these still exported means the file predates a
  // rebind (`teamai projects set`) or a role change, and the previous
  // project's secrets are live in every new shell until the next pull.
  const deliverable = new Set(declared.map((variable) => variable.key));
  const withheld = read.variables.filter((variable) => !deliverable.has(variable.key));
  const problems: string[] = [];

  // env.sh lives under teamaiHome, which is <projectRoot>/.teamai in project
  // scope and ~/.teamai in user scope — mirror the path that `teamai pull`
  // actually writes to, not a hardcoded user-home path.
  const envShPath = path.join(getDataHome(localConfig), 'env.sh');
  const envSh = await readFileSafe(envShPath);
  if (envSh === null) {
    // Nothing reaches this member and nothing was ever written: there is
    // nothing to deliver, so there is nothing to report missing.
    if (declared.length === 0) return none;
    problems.push(`${envShPath} is missing`);
  } else {
    // Read the file back through the generator's own inverse, value included:
    // a key whose value changed in env.yaml exports the old one until the next
    // pull rewrites the file, and every shell and MCP server reads that. It is
    // a parse rather than a line scan because a value may be multiline — a
    // YAML block scalar quotes into an export spanning several lines.
    const { parseEnvFile } = await import('./resources/env.js');
    const delivered = parseEnvFile(envSh);
    const undelivered: string[] = [];
    const stale: string[] = [];
    for (const variable of declared) {
      const value = delivered.get(variable.key);
      if (value === undefined) undelivered.push(variable.key);
      else if (value !== variable.value) stale.push(variable.key);
    }
    if (undelivered.length > 0) problems.push(`${envShPath} is missing ${nameList(undelivered)}`);
    if (stale.length > 0) {
      problems.push(
        `${envShPath} has a stale value for ${nameList(stale)}: env.yaml declares a different one`,
      );
    }
    const leftover = withheld.filter((variable) => delivered.has(variable.key)).map((variable) => variable.key);
    if (leftover.length > 0) {
      problems.push(
        `${envShPath} still exports ${nameList(leftover)}, which env.yaml no longer delivers to this `
        + 'directory (its roles: or projects: do not match)',
      );
    }
    // Nothing is owed, so the profile block has nothing to load: a leftover is
    // the only thing that can be wrong here.
    if (declared.length === 0) return { problems, staleProfiles: [] };
  }

  // Same resolution the injection runs, not a second copy of it. Expanded
  // up front (not left to readFileSafe's internal expansion) because the
  // stray-block scan below compares this string for identity against
  // candidates that are always absolute — an unexpanded `~/...` override
  // would never match its own resolved file and get reported as a stray
  // copy of itself (#693 review round 4).
  const profilePath = expandHome(
    teamConfig?.sharing?.env?.shellProfilePath ?? await envHandler.detectShellProfile(envShPath),
  );
  const profile = await readFileSafe(profilePath);
  const block = profile === null ? null : extractEnvBlock(profile);

  if (block === null) {
    problems.push(`${profilePath} carries no TeamAI env block`);
  } else if (envSh !== null && !envBlockSourcesPath(block, envShPath)) {
    problems.push(
      `the block in ${profilePath} does not load ${envShPath}: a POSIX shell reads an unquoted `
      + 'backslash as an escape, so the `[ -f ... ]` test fails and `source` never runs',
    );
  }

  // A stray block can also sit in a different candidate file: which file
  // `pull` prefers has changed at least once (#682), and `pull` only ever
  // adds a block, never migrates an old one away. Checking `profilePath`
  // alone would stay green forever while a dead block for this same scope
  // sits in, say, `.bashrc` from a pre-#682/#661 install (#693 review).
  const home = getUserHome();
  const staleProfiles: string[] = [];
  for (const name of SHELL_PROFILE_CANDIDATE_NAMES) {
    const candidate = path.join(home, name);
    if (sameFile(candidate, profilePath)) continue;
    const content = await readFileSafe(candidate);
    const strayBlock = content ? extractEnvBlock(content) : null;
    if (strayBlock && envBlockReferencesDataHome(strayBlock, envShPath)) {
      staleProfiles.push(candidate);
    }
  }

  return { problems, staleProfiles };
}

/**
 * The docs bundle has one destination rather than one per tool: `DocsHandler`
 * copies the whole `docs/` tree into `sharing.docs.localDir`. So this check
 * compares the two trees, file by file, rather than asking each tool.
 */
export async function buildDocsCheck(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { DocsHandler, resolveDocsDestination } = await import('./resources/docs.js');
  const handler = new DocsHandler();
  const [item] = await handler.scanTeamForPull(teamConfig, localConfig);
  if (!item) return [];

  const dest = resolveDocsDestination(teamConfig, localConfig);
  const teamFiles = (await listFilesRecursive(item.sourcePath))
    // Same filter DocsHandler.pullItem copies with: dotfiles never travel.
    .filter((file) => file.split('/').every((segment) => !segment.startsWith('.')));

  // isFile, not merely "something is there": a directory sitting on the
  // expected name, or a symlink with nothing behind it, would satisfy a plain
  // existence check while the doc is no more readable than a missing one.
  const missing: string[] = [];
  for (const file of teamFiles) {
    if (!await isReadableFile(path.join(dest, file))) missing.push(file);
  }

  return [{
    name: 'Team docs delivered',
    source: 'local',
    check: async () => missing.length === 0,
    fix: `Missing from ${dest}: ${nameList(missing)}. Run \`teamai pull --force\`: a plain `
      + 'pull skips a scope whose team repo has not changed, so it cannot restore these.',
  }];
}
