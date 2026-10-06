import path from 'node:path';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { expandHome, listFilesRecursive, pathExists, readFileSafe, readJsonObject } from './utils/fs.js';
import {
  CODEX_TOOL_ID, DEFAULT_CODEX_ROOT, getDataHome, getMcpSharing, isAgentExcluded, managedMcpManifestKey, resolveToolBaseDir,
  resolveToolRootDir, scopedToolPaths,
} from './types.js';
import type { DeliveryTarget, LocalConfig, ManagedMcpManifest, ResourceItem, TeamaiConfig } from './types.js';
import type { EntryLayout, EntryResolution } from './namespaced-entries.js';
import { splitFrontmatter } from './utils/frontmatter.js';
import { isToolInstalledForConfig, type ResourceHandler } from './resources/base.js';
import type { Check, DoctorContext } from './doctor.js';
import type { DesiredMcpContext } from './mcp-reconcile.js';
import type { ResolvedMcpFile } from './mcp-resolved-files.js';
import {
  findEnvBlockFor,
  envBlockSourcesPath,
  sameFile,
  SHELL_PROFILE_CANDIDATE_NAMES,
} from './utils/shell-profile.js';
import { getUserHome } from './utils/home.js';
import { getsRulesFromExtension, ruleFormatForTool, ruleStemsForTool } from './resources/rule-format.js';

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
  /** The tool whose format its items land in; the map key also names the tools sharing the copy. */
  tool: string;
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
  // `items` is what this member receives, so the handler need not resolve it again.
  const received = items.map((item) => item.name);
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return { byTool: new Map(), unreceived: [] };

  const byTool = new Map<string, ToolDelivery>();
  const unreceived: string[] = [];

  for (const item of items) {
    const targets = await handler.deliveryTargets(teamConfig, localConfig, item, received);
    if (targets.length === 0) unreceived.push(item.name);

    for (const target of targets) {
      // One check for a copy several tools read, naming them all (#946).
      const key = [target.tool, ...target.sharedWith ?? []].join(', ');
      let delivery = byTool.get(key);
      if (!delivery) {
        delivery = { tool: target.tool, dir: path.dirname(target.dest), problems: new Map() };
        byTool.set(key, delivery);
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

/**
 * The label for a copy pull keeps because the member changed it (#822). It is
 * not a delivery problem, so it never fails a check, and `pull --force` would
 * not replace it.
 */
const CHANGED_BY_YOU = 'changed by you (kept by pull)';
/** The advice for CHANGED_BY_YOU, when a failing check lists it. */
function changedByYouFix(delivery: ToolDelivery): string {
  return delivery.problems.has(CHANGED_BY_YOU)
    ? ' A copy changed by you is kept by pull: share it with `teamai push`, '
      + 'or delete it and run `teamai pull --force` to take the team version.'
    : '';
}

/**
 * The label for an agent copy that still carries the model the last pull
 * resolved, since changed by the member's aliases file, a model switch or the
 * team's aliases (#830). A plain pull redeploys it.
 */
const MODEL_CHANGED = 'model changed since the last pull';

/**
 * Whether a tool's delivery has a problem other than copies the member
 * changed or whose model changed since the last pull, which the next pull
 * redeploys (spec story 52 of #830).
 */
function hasDeliveryProblem(delivery: ToolDelivery): boolean {
  return [...delivery.problems.keys()].some((label) => label !== CHANGED_BY_YOU && label !== MODEL_CHANGED);
}

/**
 * What `pullItem` did not write at `target`: an older render, or a copy the
 * member changed since teamai delivered it, which pull keeps. With
 * `recordedLabel`, an older render still holding what teamai recorded writing
 * gets that label instead.
 */
async function differingCopyLabel(
  item: ResourceItem, target: DeliveryTarget, olderLabel: string, localConfig: LocalConfig, recordedLabel?: string,
): Promise<string> {
  const { deliveredHashes } = await import('./pull.js');
  const { judgeCopy, recordedUnchanged } = await import('./resources/delivered-copies.js');
  const previous = await deliveredHashes(localConfig);
  const verdict = await judgeCopy(previous, item, target);
  if (verdict.kind === 'keep') return CHANGED_BY_YOU;
  return recordedLabel !== undefined && await recordedUnchanged(previous, target.dest) ? recordedLabel : olderLabel;
}

/** `a, b, c and 4 more` — a fix a human reads, not a wall of paths. */
export function nameList(names: string[]): string {
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
/**
 * The one check for a type whose desired set cannot be resolved: two active
 * namespaces collide, or a manifest cannot be read. `pull` reports the same
 * reason, and the command whose job is explaining bad state must report it,
 * not stack-trace on it.
 */
function unresolvableCheck(type: 'skills' | 'agents' | 'docs', reason: string): Check[] {
  const noun = type[0].toUpperCase() + type.slice(1);
  return [{
    name: `${noun} to deliver can be resolved`,
    source: 'local',
    check: async () => false,
    fix: `${reason}. Until the team repo is fixed, pull cannot sync ${type} for this role.`,
  }];
}

export async function buildDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  // The desired set is policy that must not be restated here.
  const { buildRolePullContext, describeDeliveryConflict, resolveDesiredSkills } = await import('./resources/desired.js');
  const { getHandler } = await import('./resources/index.js');

  let items: ResourceItem[];
  try {
    const desired = await resolveDesiredSkills(teamConfig, localConfig, await buildRolePullContext(localConfig));
    if (desired.kind === 'conflict') return unresolvableCheck('skills', describeDeliveryConflict(desired));
    ({ items } = desired);
  } catch (e) {
    return unresolvableCheck('skills', e instanceof Error ? e.message : String(e));
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

  const { buildRolePullContext, resolveDesiredRules } = await import('./resources/desired.js');
  const { getHandler } = await import('./resources/index.js');

  const roleContext = await buildRolePullContext(localConfig);
  const { items } = await resolveDesiredRules(teamConfig, localConfig, roleContext);
  const activation = await buildRulesActivationChecks(ctx, items);
  if (items.length === 0) {
    // Failed cleanup can leave an active glob or inline block after the last rule goes.
    const failing: Check[] = [];
    for (const check of activation) if (!await check.check()) failing.push(check);
    return failing;
  }

  // `pullItem` writes the handler's render byte for byte, so anything else at
  // that path is a stale or hand-edited copy. A tool with its own rules format
  // scopes the rule by fields of it (Cursor `globs`, Kiro `inclusion`, …);
  // comparing against the render catches a wrong value there, which checking
  // the keys were present did not.
  const ruleLabels = ['not delivered', 'delivered from an older copy', RECORDED_OLDER_RULE, FLAT_NAME_TAKEN, CHANGED_BY_YOU] as const;
  const { byTool } = await walkDelivery(
    getHandler('rules'),
    ctx,
    items,
    async (target, item) => {
      // readFileSafe answers both questions at once: a directory or a dangling
      // link on the name reads as null, the same as nothing being there.
      const delivered = await readFileSafe(target.dest);
      if (delivered === null) return ruleLabels[0];
      if (target.content === undefined || delivered === target.content) return null;
      return differingCopyLabel(item, target, ruleLabels[1], localConfig, RECORDED_OLDER_RULE);
    },
  );
  // A tool that reads only the top of its rules directory gets no file for a
  // namespaced rule whose flat name another rule has (`deliveryTargets`).
  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    if (!toolPath.rules || !ruleFormatForTool(tool)?.flat || isAgentExcluded(localConfig, tool)) continue;
    if (!await isToolInstalledForConfig(tool, toolPath.rules, localConfig)) continue;
    const stems = ruleStemsForTool(tool, items.map((item) => item.name));
    const collisions = items.filter((item) => !stems.has(item.name));
    if (collisions.length === 0) continue;
    let delivery = byTool.get(tool);
    if (!delivery) {
      delivery = { tool, dir: path.join(resolveToolBaseDir(tool, localConfig), toolPath.rules), problems: new Map() };
      byTool.set(tool, delivery);
    }
    for (const item of collisions) appendTo(delivery.problems, FLAT_NAME_TAKEN, item.name);
  }
  const { unreadRulesDir } = await import('./resources/rules.js');
  const perTool: Check[] = [];
  for (const [tool, delivery] of byTool) {
    // A team `toolPaths` entry written before the tool's rules moved still
    // sends them to a directory it never reads (#946).
    const rulesPath = scopedToolPaths(teamConfig, localConfig)[delivery.tool]?.rules;
    const rulesDir = rulesPath ? path.join(resolveToolBaseDir(delivery.tool, localConfig), rulesPath) : undefined;
    const unread = rulesDir ? unreadRulesDir(delivery.tool, rulesDir, localConfig) : undefined;
    const problems = describeProblems(delivery.problems, ruleLabels);
    const restore = delivery.problems.has(ruleLabels[0]) || delivery.problems.has(ruleLabels[1]);
    perTool.push({
      name: `Rules delivered to ${tool}`,
      source: 'local',
      check: async () => !hasDeliveryProblem(delivery) && unread === undefined,
      // The fix names the directory rather than the tool: a rule's delivered
      // filename carries a per-tool extension the reader would have to derive.
      // A copy there is inert whatever its state, so only the entry is worth fixing.
      fix: unread
        ? `${unread.why}, but the team teamai.yaml's toolPaths.${delivery.tool} entry still sends the rules to `
          + `${rulesDir}: a team entry replaces teamai's default for ${delivery.tool} whole, so ${delivery.tool} gets `
          + `none of the rules copied there. In the team teamai.yaml, ${unread.toolPathsFix}, then run \`teamai pull\`.`
        : `In ${delivery.dir}, ${problems}. `
          + (delivery.problems.has(FLAT_NAME_TAKEN)
            ? `${tool} reads only the top level of that directory, so a rule not written there never reaches it: `
              + 'rename one of them in the team repo; `teamai pull` names the rules that share the file. '
            : '')
          + (restore
            ? 'Run `teamai pull --force`: a plain pull skips a scope whose team repo has not changed, '
              + 'so it cannot restore a missing copy or one teamai has no record of writing. '
            : '')
          + (delivery.problems.has(RECORDED_OLDER_RULE)
            ? 'Run `teamai pull` to rewrite a copy that still holds what teamai recorded writing: it re-renders '
              + 'one even when the team repo has not changed. '
            : '')
          + `${olderRuleCopyMeaning(delivery.tool)}${changedByYouFix(delivery)}`,
    });
  }

  return [...activation, ...perTool];
}

/** An older render of a rule that still holds what teamai recorded writing, which a plain pull re-renders. */
const RECORDED_OLDER_RULE = 'delivered in an older render teamai recorded';

/** A namespaced rule a tool reading only the top of its rules directory gets no file for. */
const FLAT_NAME_TAKEN = 'not written, as another team rule has its flat name';

/** What a rule copy "delivered from an older copy" means for `tool`, in its own format. */
function olderRuleCopyMeaning(tool: string): string {
  const fields = ruleFormatForTool(tool)?.scopeFields ?? [];
  if (fields.length === 0) {
    return `An older copy is one whose bytes are no longer the team \`.md\`, which ${tool} gets verbatim.`;
  }
  const named = fields.map((field) => `\`${field}\``);
  return `An older copy is one whose bytes are no longer what teamai renders for ${tool}, frontmatter included: `
    + `one whose ${named.slice(0, -1).join(', ')}${named.length > 1 ? ' or ' : ''}${named[named.length - 1]} drifted `
    + 'from the team `.md` applies to the wrong files while looking perfectly well-formed.';
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

  const { RulesHandler, inlinedRulesText } = await import('./resources/rules.js');
  const handler = new RulesHandler();
  const checks: Check[] = [];

  const opencode = await handler.opencodeInstructionsTarget(teamConfig, localConfig, items);
  if (opencode !== null) {
    const { readOpencodeInstructionList } = await import('./resources/opencode-config.js');
    // A missing file just lists nothing yet; null is one the pull cannot parse.
    const instructions = await pathExists(opencode.configFile) ? await readOpencodeInstructionList(opencode.configFile) : [];
    const globs = items.length > 0 ? opencode.globs : [];
    const missing = globs.filter((glob) => !instructions?.includes(glob));
    const stale = (instructions ?? []).filter((entry): entry is string =>
      typeof entry === 'string' && opencode.owns(entry) && !globs.includes(entry));
    const relativeStale = stale.filter((entry) => !path.isAbsolute(entry));
    const namespaceStale = stale.filter((entry) => path.isAbsolute(entry));
    const quoted = (entries: string[]): string => entries.map((entry) => `\`${entry}\``).join(', ');
    // Pull sets these globs even when the team repo has not moved (#946).
    const rerun = 'Run `teamai pull`.';
    checks.push({
      name: 'Team rules are active in opencode',
      source: 'local',
      check: async () => instructions !== null && missing.length === 0 && stale.length === 0,
      fix: instructions === null
        ? `${opencode.configFile} could not be read as a JSON object, so the pull left it alone `
          + 'without updating `instructions`. Fix the file, then run '
          + '`teamai pull`.'
        : [
          ...(missing.length > 0
            ? [`${opencode.configFile} does not list ${quoted(missing)} under \`instructions\`. `
              + 'OpenCode does not scan a rules directory, so every team rule delivered there is '
              + 'inert until a glob references it.']
            : []),
          ...(relativeStale.length > 0
            ? [`${opencode.configFile} still lists ${quoted(relativeStale)}, which teamai no longer writes. `
              + 'OpenCode resolves a relative entry from the session\'s working directory, so it loads '
              + 'that directory\'s rules instead of the team rules.']
            : []),
          ...(namespaceStale.length > 0
            ? [`${opencode.configFile} still lists ${quoted(namespaceStale)}, for team rules that `
              + 'no longer reach this scope, so OpenCode loads whatever copy is left there.']
            : []),
          rerun,
        ].join(' '),
    });
  }

  const { getHermesHome } = await import('./hermes-home.js');
  const hermesHome = getHermesHome();
  // SOUL.md is global and only a user-scope pull writes it; in a project,
  // `ruleChannelNotes` says why Hermes gets no project rules (#946).
  if (localConfig.scope === 'user' && !isAgentExcluded(localConfig, 'hermes') && await pathExists(hermesHome)) {
    const { getHermesSoulPath, readSoulRules } = await import('./hermes-config.js');
    const expected = await inlinedRulesText(items);
    const delivered = await readSoulRules();
    checks.push({
      name: 'Team rules are inlined in Hermes SOUL.md',
      source: 'local',
      check: async () => (items.length === 0 && delivered === null) || delivered === expected.trim(),
      fix: delivered === null
        ? `${getHermesSoulPath()} carries no teamai rules block, so Hermes reads none of the `
          + 'team rules. Run `teamai pull` to restore it.'
        : `The teamai block in ${getHermesSoulPath()} is not what the team rules inline to: `
          + 'Hermes reads standing instructions from this file rather than a rules directory, '
          + 'so a stale block is a stale rule set. Run `teamai pull` to rewrite it.',
    });
  }

  checks.push(...await buildUserRulesFileChecks(ctx, items));
  if (items.length > 0) checks.push(...await buildProjectRulesHookChecks(ctx));
  return checks;
}

/**
 * The teamai `hook-dispatch session-start` commands under `SessionStart` in a
 * Claude-shaped map of hook events (ZCode's `hooks.events`, the dsh bridge's
 * `hooks`).
 */
function sessionStartDispatches(eventMap: unknown): string[] {
  const groups = (eventMap as Record<string, unknown> | null | undefined)?.SessionStart;
  if (!Array.isArray(groups)) return [];
  return groups
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((entry: { command?: unknown; args?: unknown }) => [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])].join(' '))
    .filter((command) => command.includes('hook-dispatch session-start'));
}

/**
 * In a project, ZCode and DeepSeek Harness get the team rules only from
 * teamai's session-start hook (#946), so doctor checks the hook the tool
 * runs: ZCode reads only the user-level ~/.zcode/cli/config.json, and only
 * with `hooks.enabled`; DeepSeek Harness loads teamai's hook config only
 * through the patch, which the member passes to dsh (`ruleChannelNotes`).
 * Pi's extension is checked with the team instructions it also carries
 * (`buildInstructionDeliveryChecks`).
 */
async function buildProjectRulesHookChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig || localConfig.scope !== 'project') return [];
  const paths = scopedToolPaths(teamConfig, localConfig);
  const home = getUserHome();
  const inject = 'Run `teamai hooks inject` to rewrite it.';
  const checks: Check[] = [];

  const zcodeSettings = paths.zcode?.settings;
  if (zcodeSettings && !isAgentExcluded(localConfig, 'zcode') && await pathExists(path.join(home, '.zcode'))) {
    const file = path.join(home, zcodeSettings);
    const read = await readJsonObject(file);
    const hooks = read.kind === 'ok' ? read.value.hooks as { enabled?: unknown; events?: unknown } | undefined : undefined;
    const registered = sessionStartDispatches(hooks?.events).length > 0;
    const enabled = hooks?.enabled === true;
    checks.push({
      name: 'Project rules reach zcode through its SessionStart hook',
      source: 'local',
      check: async () => registered && enabled,
      fix: read.kind === 'invalid'
        ? `${file} is not valid JSON (${read.error}), so ZCode loads none of its hooks and sessions in this project `
          + 'get none of the team rules. Fix the file by hand (teamai does not rewrite a file it cannot parse), then run '
          + '`teamai hooks inject`.'
        : !registered
          ? `${file} has no teamai SessionStart hook, so ZCode sessions in this project get none of the team rules: `
            + `ZCode runs only the hooks in this file, none from a project. ${inject}`
          : `${file} sets hooks.enabled to something other than true, so ZCode runs none of its hooks and sessions in `
            + 'this project get none of the team rules. Run `teamai hooks inject`, which turns them on.',
    });
  }

  const { isDshInstalled } = await import('./dsh-hooks.js');
  if (!isAgentExcluded(localConfig, 'dsh') && await isDshInstalled()) {
    const { buildDshPatch, resolveDshHookConfigPath, resolveDshPatchPath } = await import('./dsh-hooks.js');
    const configPath = resolveDshHookConfigPath();
    const patchPath = resolveDshPatchPath();
    const patched = await readFileSafe(patchPath) === buildDshPatch(configPath);
    const read = await readJsonObject(configPath);
    const registered = read.kind === 'ok' && sessionStartDispatches(read.value.hooks).length > 0;
    const broken = [...(patched ? [] : [patchPath]), ...(registered ? [] : [configPath])];
    checks.push({
      name: 'Project rules reach dsh through its session-start hook',
      source: 'local',
      check: async () => broken.length === 0,
      fix: `${broken.join(' and ')} ${broken.length === 1 ? 'is' : 'are'} missing or out of date, so DeepSeek Harness `
        + 'sessions in this project get none of the team rules. Run `teamai hooks inject` to rewrite '
        + `${broken.length === 1 ? 'it' : 'them'}. dsh loads that hook only when it runs with \`--patch "${patchPath}"\`.`,
    });
  }
  return checks;
}

/**
 * In user scope each tool with no rules format reads the team rules from a
 * managed block of a file only it reads (`userRulesFile`: the Codex family's
 * AGENTS.md, #938; ZCode, DeepSeek Harness, the OpenClaw workspace, Pi,
 * JoyCode's rules.txt, #946); in a project the session-start hook (the Codex
 * family, ZCode, DeepSeek Harness) or Pi's extension adds them, and doctor
 * checks that channel instead. One check per enabled,
 * installed tool, on the bytes of the block in the file the tool reads.
 */
async function buildUserRulesFileChecks(ctx: DoctorContext, items: ResourceItem[]): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig || localConfig.scope !== 'user') return [];

  const { teamRulesBlock } = await import('./resources/rules.js');
  const { isCodexTool } = await import('./utils/tool-names.js');
  const { userRulesFile } = await import('./instruction-targets.js');
  const { TEAMAI_TEAM_RULES_START, TEAMAI_TEAM_RULES_END, scopedToolPaths } = await import('./types.js');
  const expected = await teamRulesBlock(items);
  const checks: Check[] = [];
  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    if (isAgentExcluded(localConfig, tool)) continue;
    const target = await userRulesFile(tool, toolPath, localConfig);
    if (!target?.installed) continue;
    const codexFamily = isCodexTool(tool);
    const name = codexFamily && tool !== 'codex'
      ? `Team rules are inlined in ${target.label} (${tool})`
      : `Team rules are inlined in ${target.label}`;
    if (target.unreadable) {
      const { unreadableRulesFileMessage } = await import('./instruction-targets.js');
      checks.push({ name, source: 'local', check: async () => false, fix: unreadableRulesFileMessage(tool, target.unreadable) });
      continue;
    }
    const { file } = target;
    if (file === undefined) {
      // A team `toolPaths` entry replaces the default one whole, so a Codex
      // entry written before #938 leaves it nowhere to read user rules from.
      // One with no `rules` path delivers no rules to it on purpose; with no
      // team rules it misses none.
      if (!codexFamily || items.length === 0 || !toolPath.rules) continue;
      checks.push({
        name,
        source: 'local',
        check: async () => false,
        fix: `The toolPaths entry for ${tool} has no \`claudemd\` path, so pull has no instructions `
          + `file to inline the team rules into and ${tool} reads none of them. Add `
          + `\`userScope.claudemd: .${tool}/AGENTS.md\` to that entry in the team teamai.yaml, `
          + 'then run `teamai pull`.',
      });
      continue;
    }
    const content = await readFileSafe(file);
    const start = content?.indexOf(TEAMAI_TEAM_RULES_START) ?? -1;
    const end = content?.indexOf(TEAMAI_TEAM_RULES_END) ?? -1;
    const delivered = content !== null && start !== -1 && end > start
      ? content.slice(start, end + TEAMAI_TEAM_RULES_END.length)
      : null;
    const problems: string[] = [];
    // With no rule body to inline (`expected === null`), pull writes no block.
    if (delivered === null && expected !== null) {
      problems.push(`${file} carries no team-rules block, so ${tool} reads none of the team `
        + 'rules. Run `teamai pull` to restore it.');
    } else if (delivered !== expected) {
      problems.push(`The team-rules block in ${file} is not what the team rules inline to: ${tool} reads `
        + 'the team rules from this file rather than a rules directory, so a stale block '
        + 'is a stale rule set. Run `teamai pull` to rewrite it.');
    }
    // Codex reads AGENTS.override.md instead of AGENTS.md in the same
    // directory, so a current block there is never seen. An empty or
    // whitespace-only override shadows it too (checked with `codex exec`).
    const override = path.join(path.dirname(file), 'AGENTS.override.md');
    if (codexFamily && expected !== null && await isReadableFile(override)) {
      problems.push(`${override} exists, so Codex reads it instead of ${file} and never sees the `
        + 'team rules. Move its content into AGENTS.md, or delete it.');
    }
    checks.push({ name, source: 'local', check: async () => problems.length === 0, fix: problems.join(' ') });
  }
  return checks;
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

  const { buildRolePullContext, describeDeliveryConflict, resolveDesiredAgents } = await import('./resources/desired.js');
  const { AgentsHandler } = await import('./resources/agents.js');
  const handler = new AgentsHandler();

  let items: ResourceItem[];
  try {
    const desired = await resolveDesiredAgents(teamConfig, localConfig, await buildRolePullContext(localConfig));
    if (desired.kind === 'conflict') return unresolvableCheck('agents', describeDeliveryConflict(desired));
    ({ items } = desired);
  } catch (e) {
    return unresolvableCheck('agents', e instanceof Error ? e.message : String(e));
  }
  if (items.length === 0) return [];

  // An agent whose spec reaches no tool at all is not a per-tool failure: the
  // file is in the team repo and nothing renders it anywhere.
  const agentLabels = ['not delivered', 'delivered from an older spec', MODEL_CHANGED, CHANGED_BY_YOU] as const;
  // What the last pull wrote for each agent, its model as recorded then (#830).
  const recordedTargets = new Map<string, Promise<DeliveryTarget[]>>();
  const recordedContent = async (item: ResourceItem, tool: string): Promise<string | undefined> => {
    let targets = recordedTargets.get(item.name);
    if (!targets) {
      targets = handler.recordedDeliveryTargets(teamConfig, localConfig, item);
      recordedTargets.set(item.name, targets);
    }
    return (await targets).find((target) => target.tool === tool)?.content;
  };
  const { byTool, unreceived } = await walkDelivery(
    handler,
    ctx,
    items,
    // `pullItem` writes `content` verbatim, so anything else at that path is a
    // render of an older spec — a copy that landed and is still wrong, the
    // same class as a rule whose delivered copy no longer matches its render —
    // or of the model the last pull resolved, which has changed since.
    async (target, item) => {
      // readFileSafe answers both questions at once: a directory or a dangling
      // link on the name reads as null, the same as nothing being there.
      const delivered = await readFileSafe(target.dest);
      if (delivered === null) return agentLabels[0];
      if (target.content === undefined || delivered === target.content) return null;
      if (delivered === await recordedContent(item, target.tool)) return MODEL_CHANGED;
      return differingCopyLabel(item, target, agentLabels[1], localConfig);
    },
  );
  // An agent whose model cannot be resolved is held, not unreachable: the
  // model aliases check names the reason.
  const { heldAgentNames } = await import('./doctor-agent-models.js');
  const held = await heldAgentNames(ctx);
  const unreachable = unreceived.filter((name) => !held.has(name));

  const checks: Check[] = [...byTool].map(([tool, delivery]) => {
    const modelChanged = delivery.problems.has(MODEL_CHANGED);
    const restoredByForce = [...delivery.problems.keys()].some((label) => label !== MODEL_CHANGED && label !== CHANGED_BY_YOU);
    return {
      name: `Agents delivered to ${tool}`,
      source: 'local',
      check: async () => !hasDeliveryProblem(delivery),
      fix: [
        `In ${delivery.dir}, ${describeProblems(delivery.problems, agentLabels)}.`,
        ...(modelChanged ? ['A plain `teamai pull` redeploys an agent whose model changed.'] : []),
        ...(restoredByForce
          ? [`${modelChanged ? 'For the rest, run' : 'Run'} \`teamai pull --force\`: a plain pull skips a scope whose team repo `
            + 'has not changed, so it cannot restore this.']
          : []),
      ].join(' ') + changedByYouFix(delivery),
    };
  });

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
  const { carriesResolvedValue, ensureExcludedFromGit } = await import('./mcp-git-exclude.js');
  const { mcpEntryReader, teamMcpToDef } = await import('./resources/mcp.js');
  const { describeEntryFailure, resolveEntriesFor } = await import('./namespaced-entries.js');

  // A file that does not parse, or a server name defined twice, is not a team
  // without MCP: the pull logs the reason once and changes nothing in any tool,
  // and every later run is silent. Flattening it to an empty desired set is
  // what let `doctor --json` answer `ok: true` over a team whose MCP is stuck.
  const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
  if (resolution.kind === 'failed') {
    return [{
      name: 'Team MCP servers can be read',
      source: 'local',
      check: async () => false,
      fix: describeEntryFailure(resolution.failure),
    }];
  }

  const teamDefs = resolution.entries.map((entry) => teamMcpToDef(entry.entry));
  if (teamDefs.length === 0) return [];

  const targets = await resolveMcpTargets(teamConfig, localConfig);
  const desiredContext = await buildDesiredMcpContext(teamConfig, localConfig, { teamEnv: ctx.teamEnv });
  const excludedByUser = new Set(localConfig.excludedSkills ?? []);

  const checks: Check[] = [];
  for (const target of targets) {
    if (mcpTargetExcluded(localConfig, target)) continue;

    const { desired, skipped, kept } = desiredMcpForTarget(target, teamDefs, desiredContext);
    // A server skipped only for a missing declared secret (#875) is a note
    // doctor prints with the command that fixes it, not a failed delivery.
    const blocked = skipped
      .filter((change) => !excludedByUser.has(change.server) && !kept.has(change.server))
      .map((change) => `${change.server} (${change.reason ?? 'skipped'})`);

    const problems: string[] = [];
    // Its fix is the exclusion's own, not another pull (#882).
    let withheld: string | undefined;
    const installed = await installedMcpEntries(target, { underKeyOnly: true });
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
      // Pull writes a resolved value only into a file git leaves out of a
      // commit (#882), and otherwise leaves the whole file as it was.
      const exclusion = carriesResolvedValue(target, teamDefs, [...absent, ...foreign])
        ? await ensureExcludedFromGit(target.file, { dryRun: true })
        : undefined;
      if (exclusion?.kind === 'failed') {
        withheld = `In ${target.file}, withheld: ${nameList([...absent, ...foreign])}, as git would commit the file: ${exclusion.reason}. ${exclusion.fix}`;
      } else {
        if (absent.length > 0) problems.push(`not injected: ${nameList(absent)}`);
        if (foreign.length > 0) problems.push(`not the team's definition: ${nameList(foreign)}`);
      }
    }
    if (blocked.length > 0) problems.push(`skipped: ${nameList(blocked)}`);

    if (problems.length === 0 && !withheld && desired.size === 0) continue;

    const delivery = problems.length === 0 ? [] : [`In ${target.file}, ${problems.join('; ')}. A server needing a variable reads it from `
      + '`env/env.yaml` or an active `env/<ns>/env.yaml`, whose top-level key is `variables:` — a plain `KEY: value` mapping '
      + 'parses as no variables at all. Then run `teamai pull --force`: a pull leaves an entry '
      + 'teamai does not own untouched, so a server of your own under a team name only gives '
      + 'way to `--force`.'];
    checks.push({
      name: `MCP servers delivered to ${target.tool}`,
      source: 'local',
      check: async () => problems.length === 0 && !withheld,
      fix: [...withheld ? [withheld] : [], ...delivery].join(' '),
    });
  }

  return checks;
}

/** Codex's verdict on a project, from the `projects` table of its user config. */
type CodexProjectTrust =
  | { kind: 'trusted' }
  | { kind: 'untrusted'; decidedBy?: { dir: string; level: string } }
  | { kind: 'unreadable'; reason: string };

/**
 * Codex takes the first `projects."<dir>"` entry holding a `trust_level` for
 * the checkout, then for the main checkout of its repository, each keyed by
 * real path; an entry without one decides nothing. `dirs` lists them in that
 * order.
 */
async function codexProjectTrust(configFile: string, dirs: string[]): Promise<CodexProjectTrust> {
  if (!await pathExists(configFile)) return { kind: 'untrusted' };
  const raw = await readFileSafe(configFile);
  if (raw === null) return { kind: 'unreadable', reason: 'could not be read' };
  let projects: unknown;
  try {
    const { parse } = await import('smol-toml');
    projects = parse(raw).projects;
  } catch (error) {
    return { kind: 'unreadable', reason: `could not be parsed (${error instanceof Error ? error.message.split('\n')[0] : String(error)})` };
  }
  if (typeof projects !== 'object' || projects === null) return { kind: 'untrusted' };
  for (const dir of dirs) {
    const level = ((projects as Record<string, { trust_level?: unknown } | undefined>)[dir])?.trust_level;
    if (typeof level !== 'string') continue;
    return level === 'trusted' ? { kind: 'trusted' } : { kind: 'untrusted', decidedBy: { dir, level } };
  }
  return { kind: 'untrusted' };
}

/** The manual fix for a project Codex does not trust; `cause` opens the sentence. */
function codexTrustFix(trust: Exclude<CodexProjectTrust, { kind: 'trusted' }>, cause: string, configFile: string, main: string): string {
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
      return `${cause}, and ${configFile} does not trust ${main}. Open Codex in ${main} and trust the project `
        + `when it asks, or add a ${table(main)} table holding trust_level = "trusted" to ${configFile}. `
        + 'Trusting the main checkout covers every worktree of it.';
  }
}

/**
 * Codex loads a project's `.codex/config.toml` only in a trusted project, and
 * skips an untrusted one silently (#954), so team servers a pull or
 * `teamai mcp inject` wrote there are on disk and inert. Built while that file
 * holds a server this worktree's `managed-mcp.json` records for Codex.
 * Read-only: this check only reads Codex's config.
 */
export async function buildCodexProjectTrustCheck(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  const { projectRoot } = localConfig;
  if (!teamConfig || localConfig.scope !== 'project' || !projectRoot) return [];

  const { resolveMcpTargets, mcpTargetExcluded, installedMcpEntries } = await import('./mcp-reconcile.js');
  const { isCodexTrustGatedTool } = await import('./hooks.js');
  const target = (await resolveMcpTargets(teamConfig, localConfig))
    .find((candidate) => isCodexTrustGatedTool(candidate.tool) && !mcpTargetExcluded(localConfig, candidate));
  if (!target) return [];

  const { loadProjectMcpManifest } = await import('./utils/mcp-manifest.js');
  const { manifest } = await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true });
  const installed = await installedMcpEntries(target);
  const names = (manifest[managedMcpManifestKey(target.tool, true)] ?? [])
    .map((record) => record.name)
    .filter((name) => installed?.has(name));
  if (names.length === 0) return [];

  const { resolveAnchors } = await import('./utils/git.js');
  const { realFilePath } = await import('./mcp-git-exclude.js');
  const root = await realFilePath(projectRoot);
  const anchors = await resolveAnchors(projectRoot);
  const main = anchors?.projectAnchor ?? root;
  const dirs = [...new Set([root, anchors?.workspaceRoot ?? root, main])];
  const configFile = path.join(resolveToolRootDir(CODEX_TOOL_ID, DEFAULT_CODEX_ROOT, localConfig.toolRoots), 'config.toml');
  const trust = await codexProjectTrust(configFile, dirs);
  const cause = `${target.file} holds team MCP servers (${nameList(names)}), but Codex loads a project's `
    + '.codex/config.toml only in a trusted project';

  return [{
    name: 'Codex trusts this project, so it loads its team MCP servers',
    source: 'local',
    check: async () => trust.kind === 'trusted',
    fix: trust.kind === 'trusted' ? '' : codexTrustFix(trust, cause, configFile, main),
  }];
}

/**
 * A project MCP config holding a resolved `${VAR}` that git would commit
 * (#882). Pull lists such a file in `.git/info/exclude`; this is the standing
 * check for a file that is tracked already, or a repo whose exclude could not
 * be written. For an HTTP-backed team, whose local agent writes the servers,
 * a config holding a credential its install recorded. Read-only:
 * `git check-ignore` changes nothing.
 */
export async function buildMcpGitExcludeCheck(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  const { projectRoot } = localConfig;
  if (!teamConfig || localConfig.scope !== 'project' || !projectRoot) return [];

  const {
    resolveMcpTargets, resolvedValueEvidence, buildVarTable, buildDesiredMcpContext, recordedMcpTargets, recordedMcpFileEvidence, localAgentCredentialFiles,
    earlierMappedMcpTargets, earlierMappedMcpFileEvidence, ownedByMappers, unrecordedMcpTool, unmappedMcpDefaults, unrecordedUnmappedMcpDefaults, unclaimedMcpServers,
  } = await import('./mcp-reconcile.js');
  const { readResolvedMcpFiles } = await import('./mcp-resolved-files.js');
  const { gitPathOf, gitTracking, gitTracks } = await import('./mcp-git-exclude.js');
  const { sameServerKey } = await import('./resources/mcp-format.js');
  const { mcpEntryReader, teamMcpToDef } = await import('./resources/mcp.js');
  const { resolveEntriesFor } = await import('./namespaced-entries.js');
  const { loadProjectMcpManifest } = await import('./utils/mcp-manifest.js');

  // Unreadable team servers still leave teamai's entries on disk: judged by the manifest, as pull does.
  const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
  const teamDefs = resolution.kind === 'failed' ? null : resolution.entries.map((entry) => teamMcpToDef(entry.entry));
  let manifest: ManagedMcpManifest | undefined;
  let vars: Record<string, string> | undefined;
  let ledger: Record<string, ResolvedMcpFile> | undefined;
  let desiredContext: Promise<DesiredMcpContext> | undefined;
  const desired = (): Promise<DesiredMcpContext> => desiredContext ??= buildDesiredMcpContext(teamConfig, localConfig);

  const holding = new Set<string>();
  const tracked: string[] = [];
  const hold = async (file: string): Promise<void> => {
    holding.add(file);
    const tracking = await gitTracking(file);
    if (tracking.kind === 'would-commit') tracked.push((await gitPathOf(file)).label);
    else if (tracking.kind === 'unknown') tracked.push(`${(await gitPathOf(file)).label} (git failed: ${tracking.error})`);
  };
  // Every tool's file, delivery on or off, the same files and evidence pull protects. Two tools may share one.
  const mapped = await resolveMcpTargets(teamConfig, localConfig, { includeUndetected: true });
  // A built-in location no mapping reaches today (its tool moved or dropped): its tool's records describe another file.
  const unmapped = await unmappedMcpDefaults(mapped);
  const targets = mapped.filter((target) => !unmapped.has(target));
  const report = (held: string, next: string): Check[] => holding.size === 0 ? [] : [{
    name: 'Project MCP configs with resolved values are kept out of git',
    source: 'local',
    check: async () => tracked.length === 0,
    fix: `${tracked.join(', ')} may hold ${held}, and git would commit them or cannot say. ${next}`,
  }];
  if (localConfig.repo.kind === 'http') {
    // No mcp.yaml to judge by: the files that may hold a credential the local agent wrote.
    for (const { file } of await localAgentCredentialFiles(localConfig, targets)) {
      if (!holding.has(file)) await hold(file);
    }
    return report('MCP credentials in plaintext', 'Fix any git error shown, then add each to .git/info/exclude. If git already tracks one, run '
      + '`git rm --cached <file>` and rotate the values it held.');
  }
  for (const target of targets) {
    if (holding.has(target.file) || !await pathExists(target.file)) continue;
    manifest ??= (await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true })).manifest;
    vars ??= await buildVarTable(localConfig);
    ledger ??= (await readResolvedMcpFiles(localConfig)).files;
    const owned = manifest[managedMcpManifestKey(target.tool, true)] ?? [];
    // No managed-mcp.json at all, no record for this installed tool the team maps, or a record a pull wrote
    // without one whose note hasn't landed: any server no record claims may be teamai's, as pull judges it.
    const claimed = targets.filter((t) => t.file === target.file && sameServerKey(t.format, target.format))
      .flatMap((t) => manifest?.[managedMcpManifestKey(t.tool, true)] ?? []).map((record) => record.name);
    const unrecorded = unrecordedMcpTool(target, targets, ledger[target.file]?.tools) && manifest[managedMcpManifestKey(target.tool, true)] === undefined;
    if (((Object.keys(manifest).length === 0 || unrecorded || owned.some((record) => record.unnoted))
      && (await unclaimedMcpServers(target, claimed)).length > 0)
      || await resolvedValueEvidence(target, teamDefs, { owned, unverified: ledger[target.file]?.unverified }, vars, desired)) await hold(target.file);
  }
  // And a file a pull wrote under a mapping the team has since changed, but one recorded as tracked while git
  // tracks it: no line protects it. In a file another tool now maps, that tool's records tell its own servers.
  for (const [file, { targets: group, mappedBy, tracked }] of await recordedMcpTargets(localConfig, targets)) {
    if (holding.has(file) || (tracked && (await gitTracks(file)).kind === 'tracked')) continue;
    manifest ??= (await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true })).manifest;
    if (await recordedMcpFileEvidence(group, ownedByMappers(mappedBy, manifest))) await hold(file);
  }
  // And, until a pull on this version reads them, those an older teamai wrote under a mapping an earlier
  // teamai.yaml made. Read-only: the record of that read is pull's. Unreadable history skips them.
  // A built-in location no mapping reaches today, which no record covers, is judged as one of them.
  const earlier = (await readResolvedMcpFiles(localConfig)).earlierMappingsRead ? []
    : await earlierMappedMcpTargets(localConfig, mapped).catch(() => null) ?? [];
  for (const { tracked, mappedBy, ...target } of [...earlier, ...await unrecordedUnmappedMcpDefaults(localConfig, unmapped, targets)]) {
    if (tracked || holding.has(target.file)) continue;
    vars ??= await buildVarTable(localConfig);
    manifest ??= (await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true })).manifest;
    if (await earlierMappedMcpFileEvidence(target, teamDefs, vars, desired, ownedByMappers(mappedBy, manifest))) await hold(target.file);
  }
  return report('MCP variables resolved to plaintext', 'Fix any git error shown, then run `teamai pull` to list them in .git/info/exclude. If git already tracks one, run '
    + '`git rm --cached <file>` and rotate the values it held.');
}

/**
 * Env, hook and MCP entries carrying a key to fix: the per-entry `roles:` /
 * `projects:` keys that namespace files replace (#707), or a key the entry's
 * schema does not know (#822). An entry with an unknown key or `projects:` (and
 * `roles:` on env) is not delivered; `roles:` on hooks and MCP still filters
 * for one minor release. Pull warns once per run, and this is the standing
 * version of that warning. Informational: each entry resolves as its warning says.
 */
export async function buildEntryScopeKeyCheck(ctx: DoctorContext): Promise<Check[]> {
  const messages = (await resolveEntryTypes(ctx.localConfig))
    .flatMap(({ resolution }) => resolution.notices)
    .filter((notice) => notice.kind !== 'file-note')
    .map((notice) => notice.message);
  if (messages.length === 0) return [];
  return [{
    name: 'Team env, hooks and MCP entries have no per-entry key to fix',
    source: 'local',
    informational: true,
    check: async () => false,
    fix: messages.join(' '),
  }];
}

/**
 * A failing check for hooks, model profiles and team secrets that do not
 * resolve: pull keeps what is installed and says why once, then every later
 * run is silent, and `teamai status` sends the member here. Env and MCP report
 * the same failure in their own delivery checks.
 */
export async function buildEntryResolutionChecks(ctx: DoctorContext): Promise<Check[]> {
  const { describeEntryFailure } = await import('./namespaced-entries.js');
  const checks: Check[] = [];
  for (const { checkName: name, resolution } of await resolveEntryTypes(ctx.localConfig)) {
    if (name === null || resolution.kind !== 'failed') continue;
    checks.push({ name, source: 'local', check: async () => false, fix: describeEntryFailure(resolution.failure) });
  }
  return checks;
}

/**
 * The member's values for this team and machine can be read (#875). While one
 * can't, every secret has no value and MCP keeps what the last pull wrote,
 * which the MCP check can't see. Only for a scope whose secrets or variables
 * read those files.
 */
export function buildSecretValuesCheck(ctx: DoctorContext): Check[] {
  const { teamEnv } = ctx;
  if (!teamEnv) return [];
  const reads = (teamEnv.declarations.kind === 'resolved' && teamEnv.declarations.entries.length > 0)
    || (teamEnv.variables.kind === 'resolved' && teamEnv.variables.entries.length > 0);
  if (!reads) return [];
  const unreadable = [teamEnv.secrets, teamEnv.variableValues].find((values) => values.kind === 'store-unreadable');
  return [{
    name: 'Your team secret values can be read',
    source: 'local',
    check: async () => unreadable === undefined,
    fix: unreadable?.kind === 'store-unreadable' ? unreadable.reason : undefined,
  }];
}

/**
 * Info lines for `doctor`: which namespace entry replaces which root entry,
 * and in legacy mode each name the root file repeats. They answer "why do I
 * have this value?" and are not problems, so they are notes, not checks.
 */
export async function entryNamespaceNotes(ctx: DoctorContext): Promise<string[]> {
  const { describeEntryNotes } = await import('./namespaced-entries.js');
  return (await resolveEntryTypes(ctx.localConfig)).flatMap(({ layout, resolution }) => describeEntryNotes(layout, resolution));
}

/**
 * Every namespaced entry file set, each with the layout its messages use and
 * the doctor check that fails when it does not resolve (null for env and MCP,
 * whose delivery checks report it).
 */
async function resolveEntryTypes(
  localConfig: LocalConfig,
): Promise<{ layout: EntryLayout; resolution: EntryResolution<unknown>; checkName: string | null }[]> {
  if (localConfig.repo.kind === 'http') return [];
  const { entryLayout, resolveEntriesFor } = await import('./namespaced-entries.js');
  const { envEntryReader } = await import('./resources/env.js');
  const { SECRETS_LAYOUT, secretsEntryReader } = await import('./resources/secrets.js');
  const { hooksEntryReader } = await import('./resources/hooks.js');
  const { mcpEntryReader } = await import('./resources/mcp.js');
  const { modelsEntryReader } = await import('./models/profile.js');
  return [
    { layout: entryLayout('env'), resolution: await resolveEntriesFor(envEntryReader, localConfig), checkName: null },
    {
      layout: SECRETS_LAYOUT,
      resolution: await resolveEntriesFor(secretsEntryReader, localConfig),
      checkName: 'Team secrets can be resolved',
    },
    {
      layout: entryLayout('hooks'),
      resolution: await resolveEntriesFor(hooksEntryReader, localConfig),
      checkName: 'Team hooks can be resolved',
    },
    { layout: entryLayout('mcp'), resolution: await resolveEntriesFor(mcpEntryReader, localConfig), checkName: null },
    {
      layout: entryLayout('models'),
      resolution: await resolveEntriesFor(modelsEntryReader, localConfig),
      checkName: 'Team model profiles can be resolved',
    },
  ];
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

  const { EnvHandler } = await import('./resources/env.js');
  const envHandler = new EnvHandler();

  // The variables this member and directory receive: the same resolution pull
  // writes env.sh from, not a second copy of it. A file that cannot be used, or
  // a name defined twice, is reported here as pull reports it (#662), and a
  // deliberate `variables: []` is not.
  const { describeEntryFailure } = await import('./namespaced-entries.js');
  const { envShVariables, resolveTeamEnv } = await import('./env-resolution.js');
  const teamEnv = ctx.teamEnv ?? await resolveTeamEnv(localConfig);
  const { variables: resolution, declarations: secrets, variableValues: values } = teamEnv;
  if (resolution.kind === 'failed') return { problems: [describeEntryFailure(resolution.failure)], staleProfiles: [] };
  // A key the team also declares as a secret is not delivered (#875); declarations
  // that cannot be read keep env.sh as it is, as a broken env file does.
  if (secrets.kind === 'failed') return { problems: [describeEntryFailure(secrets.failure)], staleProfiles: [] };
  // A variable the member set for this team is owed their value, and one set
  // with `--from-env` is not owed at all (#875); a values file that cannot be
  // read keeps env.sh as it is, as pull does.
  if (values.kind === 'store-unreadable') return { problems: [values.reason], staleProfiles: [] };
  const declared = envShVariables(resolution.entries, values.values);
  const deliverable = new Set(declared.map((variable) => variable.key));
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
        `${envShPath} has a stale value for ${nameList(stale)}: env.yaml or your value for this team is a different one`,
      );
    }
    // env.sh holds only what pull wrote, so a key the resolved set lacks is
    // left over from before a namespace deactivated or the team removed it,
    // and still live in every new shell until the next pull.
    const leftover = [...delivered.keys()].filter((key) => !deliverable.has(key));
    if (leftover.length > 0) {
      problems.push(
        `${envShPath} still exports ${nameList(leftover)}, which the team no longer delivers to this `
        + 'directory (removed, or its namespace is no longer active)',
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
  // This scope's own block: the profile can also carry another scope's
  // (#876), and that one is not this scope's to judge.
  const profile = await readFileSafe(profilePath);
  const block = profile === null ? null : findEnvBlockFor(profile, envShPath);

  if (block === null) {
    problems.push(`${profilePath} carries no TeamAI env block for ${envShPath}`);
  } else if (envSh !== null && !envBlockSourcesPath(block.text, envShPath)) {
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
    if (content && findEnvBlockFor(content, envShPath)) staleProfiles.push(candidate);
  }

  return { problems, staleProfiles };
}

/**
 * The docs bundle has one destination rather than one per tool: `DocsHandler`
 * mirrors the team's visible `docs/` tree into `sharing.docs.localDir`. So this
 * check compares the delivered set with that directory, file by file, rather
 * than asking each tool.
 */
export async function buildDocsCheck(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { listDocFiles, listStaleDocDirectories, resolveDocsForDirectory, resolveDocsDestination } = await import('./resources/docs.js');
  // The set pull delivers: no dotfiles, nothing of a docs namespace this member
  // does not have active (#707). Manifests that cannot be read leave nothing to
  // compare against, and pull stops the scope over them.
  let desired: Awaited<ReturnType<typeof resolveDocsForDirectory>>;
  try {
    desired = await resolveDocsForDirectory(localConfig);
  } catch (e) {
    return unresolvableCheck('docs', e instanceof Error ? e.message : String(e));
  }

  const dest = resolveDocsDestination(teamConfig, localConfig);
  let localFiles: string[];
  let staleDirectories: string[];
  try {
    localFiles = await listDocFiles(dest);
    staleDirectories = await listStaleDocDirectories(desired.sourceDir, dest);
  } catch (e) {
    return [{
      name: 'Team docs delivered', source: 'local', check: async () => false,
      fix: `Could not inspect the docs mirror: ${e instanceof Error ? e.message : String(e)}. Check directory access, then run \`teamai pull --force\`.`,
    }];
  }
  const teamFiles = desired.files;
  if (teamFiles.length === 0 && localFiles.length === 0 && staleDirectories.length === 0) return [];
  // A team doc of a namespace not active here is not stale: pull removes the
  // unchanged copy and names the edited one it keeps.
  const known = new Set([
    ...teamFiles,
    ...desired.withheld.flatMap(({ dir, files }) => files.map((file) => `${dir}/${file}`)),
  ]);
  const stale = [...localFiles.filter(file => !known.has(file)), ...staleDirectories];

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
    check: async () => missing.length === 0 && stale.length === 0,
    fix: [
      ...(missing.length ? [`Missing from ${dest}: ${nameList(missing)}.`] : []),
      ...(stale.length ? [`Stale docs in ${dest}: ${nameList(stale)}.`] : []),
      'Run `teamai pull --force` to restore the docs mirror; a plain pull skips an already-synced revision.',
    ].join(' '),
  }];
}

/**
 * Information lines, not checks, that answer "why do I have this version?"
 * (#707). With roles or projects: each namespace skill, agent, rule or
 * claudemd file that replaces a root item of the same name. In legacy mode,
 * where nothing replaces anything: each name the team repo defines more than
 * once, and what the member receives because of it.
 *
 * A team repo whose desired sets cannot be resolved yields no lines: the
 * delivery checks already report that as a failure.
 */
export async function buildNamespaceNotes(ctx: DoctorContext): Promise<string[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];

  const { describeOverride, repeatedNames } = await import('./namespace-resolver.js');
  let team: Awaited<ReturnType<typeof readNamespaceNoteInputs>>;
  try {
    team = await readNamespaceNoteInputs(teamConfig, localConfig);
  } catch {
    return [];
  }

  if (team.mode === 'legacy') {
    const firstLevelRules = team.rules.filter((rule) => rule.name.split('/').length <= 2);
    // claudemd file names at the root and one level down, as the block collects them.
    // listFilesRecursive joins with '/' on every platform.
    const claudemdFiles = team.claudemdFiles
      .map((file) => file.split('/'))
      .filter((segments) => segments.length <= 2 && (segments[segments.length - 1] ?? '').endsWith('.md'));
    return [
      ...repeatedNames(team.skills, (item) => item.name, (item) => item.relativePath).map(([name, sources]) => (
        `skills: "${name}" is defined in ${listed(sources)} (legacy mode: only one of them is installed)`)),
      ...repeatedNames(firstLevelRules, (item) => path.posix.basename(item.name), (item) => item.relativePath)
        .map(([name, sources]) => (
          `rules: "${name}" is defined in ${listed(sources)} (legacy mode: each is delivered at its own path)`)),
      ...repeatedNames(claudemdFiles, (segments) => segments[segments.length - 1] ?? '', (segments) => `claudemd/${segments.join('/')}`)
        .map(([name, sources]) => (
          `claudemd: "${name}" is defined in ${listed(sources)} (legacy mode: all of them are in the managed block)`)),
    ];
  }

  return [
    ...(team.skills.kind === 'resolved' ? team.skills.overrides : []).map((override) => describeOverride('skills', override)),
    ...(team.agents.kind === 'resolved' ? team.agents.overrides : []).map((override) => describeOverride('agents', override)),
    ...team.rules.overrides.map((override) => describeOverride('rules', override)),
    ...team.claudemd.overrides.map((override) => describeOverride('claudemd', override)),
  ];
}

/** What `buildNamespaceNotes` reads from the team repo; throws when a manifest cannot be read. */
async function readNamespaceNoteInputs(teamConfig: TeamaiConfig, localConfig: LocalConfig) {
  const desired = await import('./resources/desired.js');
  const { getHandler } = await import('./resources/index.js');
  const roleContext = await desired.buildRolePullContext(localConfig);
  if (!roleContext) {
    return {
      mode: 'legacy' as const,
      skills: await getHandler('skills').scanTeamForPull(teamConfig, localConfig),
      rules: await getHandler('rules').scanTeamForPull(teamConfig, localConfig),
      claudemdFiles: await listFilesRecursive(path.join(localConfig.repo.localPath, 'claudemd')),
    };
  }
  return {
    mode: 'namespaced' as const,
    skills: await desired.resolveDesiredSkills(teamConfig, localConfig, roleContext),
    agents: await desired.resolveDesiredAgents(teamConfig, localConfig, roleContext),
    rules: await desired.resolveDesiredRules(teamConfig, localConfig, roleContext),
    claudemd: await desired.collectClaudemdFiles(localConfig.repo.localPath, roleContext),
  };
}

function listed(sources: string[]): string {
  return sources.length <= 2
    ? sources.join(' and ')
    : `${sources.slice(0, -1).join(', ')} and ${sources[sources.length - 1]}`;
}

/**
 * Team instructions (#945): whether each installed tool can load this
 * member's culture, claudemd and recall blocks, not only whether a file was
 * written. A file target must hold the current blocks, and OpenCode's must be
 * listed in its `instructions`; a hook target needs teamai's extension or
 * plugin as this build writes it, and room in its channel; and no file an
 * earlier release wrote may still hold blocks.
 */
export async function buildInstructionDeliveryChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];
  const {
    holdsInstructionBlocks, hookLimitProblem, instructionHookChannel, instructionHookText, instructionTargetPath,
    planInstructionFiles, resolveInstructionTargets,
  } = await import('./instruction-targets.js');
  const { resolveInstructionBlocks } = await import('./pull.js');
  const { buildRolePullContext } = await import('./resources/desired.js');
  const { opencodeContextReference, readOpencodeInstructionList } = await import('./resources/opencode-config.js');
  const { blocks } = await resolveInstructionBlocks(teamConfig, localConfig, await buildRolePullContext(localConfig));
  const { targets, hooks, stale } = await resolveInstructionTargets(teamConfig, localConfig);
  const pullNow = 'Run `teamai pull`.';
  const checks: Check[] = [];

  for (const target of targets) {
    const plan = await planInstructionFiles([target], blocks);
    checks.push({
      name: `Team instructions are current for ${target.tools.join(', ')}`,
      source: 'local',
      check: async () => plan.changes.length === 0 && plan.warnings.length === 0,
      fix: plan.warnings.length > 0
        ? plan.warnings.join(' ')
        : `${target.path} does not hold this member's current team instructions. ${pullNow}`,
    });
  }

  const opencodePaths = scopedToolPaths(teamConfig, localConfig).opencode;
  const opencodeFile = opencodePaths && await instructionTargetPath('opencode', opencodePaths, localConfig);
  // Only a file holding the blocks needs listing; pull registers it once it writes them.
  if (opencodeFile && targets.some((t) => t.path === opencodeFile) && await holdsInstructionBlocks(opencodeFile)) {
    const { config, entry } = opencodeContextReference(opencodeFile, localConfig.scope, resolveToolBaseDir('opencode', localConfig));
    const instructions = await readOpencodeInstructionList(config);
    checks.push({
      name: 'Team instructions are listed in opencode instructions',
      source: 'local',
      check: async () => instructions !== null && instructions.includes(entry),
      fix: instructions === null
        ? `${config} could not be read as a JSON object, so the pull left it alone and OpenCode never loads ${opencodeFile}. `
          + `Fix the file or add "${entry}" to its "instructions" by hand, then run \`teamai pull\`.`
        : `${config} does not list "${entry}" under "instructions", and OpenCode reads no file it is not told about. ${pullNow}`,
    });
  }

  // Pi's extension also carries the project's team rules (#946).
  const { teamRulesContext } = await import('./resources/rules.js');
  let hasTeamRules: boolean | undefined;
  for (const hook of hooks) {
    const text = instructionHookText(blocks, hook.recall);
    if (!text && !getsRulesFromExtension(hook.tool)) continue;
    if (!text && !(hasTeamRules ??= await teamRulesContext(teamConfig, localConfig) !== null)) continue;
    const channel = await instructionHookChannel(hook.tool, { teamConfig, localConfig });
    const overLimit = hookLimitProblem(hook, text);
    checks.push({
      name: `${hook.tool} adds the team instructions${getsRulesFromExtension(hook.tool) ? ' and rules' : ''} to its prompt`,
      source: 'local',
      check: async () => channel.ready && overLimit === null,
      fix: channel.ready ? overLimit ?? '' : channel.fix,
    });
  }

  const leftovers: string[] = [];
  const warnings: string[] = [];
  for (const file of stale) {
    const plan = await planInstructionFiles([], {}, [file]);
    if (plan.changes.length > 0 || plan.warnings.length > 0) leftovers.push(file.path);
    warnings.push(...plan.warnings);
  }
  checks.push({
    name: 'No team instruction blocks are left in files no tool loads them from',
    source: 'local',
    check: async () => leftovers.length === 0,
    fix: [...warnings, `Earlier teamai releases left team instruction blocks in ${nameList(leftovers)}, which can carry another member's selection. ${pullNow}`].join(' '),
  });
  return checks;
}
