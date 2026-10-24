import type { AgentModelRecords, RecordedAgentModel, ResourceItem } from './types.js';
import type { AgentSpec, ToolName } from './resources/agent-format.js';
import type { ModelAliases, ModelResolution } from './models/aliases.js';
import type { Check, CheckStage, DoctorContext } from './doctor.js';
import { readFileSafe } from './utils/fs.js';
import { nameList } from './doctor-delivery.js';

/**
 * What `doctor` says about the model aliases agents use (#830): a failing
 * check while they cannot be resolved, since pull then holds every agent with
 * a `model` (only the alias agents, when only the member's file fails) and
 * says so only on a full sync; and, as notes, how each alias
 * agent resolved in each tool, why, and what the alias files set that no tool
 * receives. Read-only, like every doctor check.
 */

/** The YAML agents this member receives that set a `model`, with what resolving them needs. */
interface AgentModelView {
  aliases: ModelAliases;
  agents: { name: string; spec: AgentSpec }[];
  /** The installed tools that receive agents. */
  tools: ToolName[];
  records: AgentModelRecords;
}

const CHECK_NAME = 'Agent model aliases can be resolved';

/** One load per doctor run: the check, the delivery check and the notes read the same view. */
const views = new WeakMap<DoctorContext, Promise<AgentModelView | null>>();

function loadView(ctx: DoctorContext): Promise<AgentModelView | null> {
  let view = views.get(ctx);
  if (!view) {
    view = readView(ctx);
    views.set(ctx, view);
  }
  return view;
}

async function readView(ctx: DoctorContext): Promise<AgentModelView | null> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig || localConfig.repo.kind === 'http') return null;
  const { loadModelAliases } = await import('./models/aliases.js');
  const { buildRolePullContext, resolveDesiredAgents } = await import('./resources/desired.js');
  const { parseAgentYaml } = await import('./resources/agent-format.js');
  const { AgentsHandler } = await import('./resources/agents.js');
  const { recordedAgentModels } = await import('./pull.js');

  const aliases = await loadModelAliases(localConfig);
  // A desired set that cannot be resolved is the agents delivery check's to report.
  let items: ResourceItem[] = [];
  try {
    const desired = await resolveDesiredAgents(teamConfig, localConfig, await buildRolePullContext(localConfig));
    if (desired.kind === 'resolved') items = desired.items;
  } catch {
    items = [];
  }
  const agents: AgentModelView['agents'] = [];
  for (const item of items) {
    if (!item.sourcePath.endsWith('.yaml')) continue;
    const content = await readFileSafe(item.sourcePath);
    const parsed = content === null ? null : parseAgentYaml(content, `${item.name}.yaml`);
    if (parsed?.ok && parsed.spec.model !== undefined) agents.push({ name: item.name, spec: parsed.spec });
  }
  if (agents.length === 0) return { aliases, agents, tools: [], records: {} };
  const tools = (await new AgentsHandler().agentToolDirs(teamConfig, localConfig)).map(({ tool }) => tool);
  return { aliases, agents, tools, records: await recordedAgentModels(localConfig) };
}

/** Each installed tool `spec` targets, with what it receives for `spec`'s model. */
async function resolutions(view: AgentModelView, spec: AgentSpec): Promise<{ tool: ToolName; resolution: ModelResolution }[]> {
  const { resolveAgentModel } = await import('./models/aliases.js');
  return view.tools
    .filter((tool) => !spec.targets || spec.targets.includes(tool))
    .map((tool) => ({ tool, resolution: resolveAgentModel(view.aliases, spec, tool) }));
}

/** The received agents pull holds in at least one tool, because their model cannot be resolved there. */
export async function heldAgentNames(ctx: DoctorContext): Promise<Set<string>> {
  const view = await loadView(ctx);
  const held = new Set<string>();
  for (const { name, spec } of view?.agents ?? []) {
    if ((await resolutions(view!, spec)).some(({ resolution }) => !resolution.ok)) held.add(name);
  }
  return held;
}

/**
 * A failing check while agents' models cannot be resolved: an aliases file
 * with a structural error (active or not, the member's own included), one
 * alias in two active namespaces, or a switched tool whose state cannot be
 * read. It passes, and is listed, only where some agent uses an alias. The
 * post-pull pass reads only the files, as parsing every agent spec would
 * spend its budget.
 */
export async function buildAgentModelChecks(ctx: DoctorContext, stage: CheckStage): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig || localConfig.repo.kind === 'http') return [];
  const failing = (fix: string): Check[] => [{ name: CHECK_NAME, source: 'local', reportedByPull: 'model-aliases', check: async () => false, fix }];

  if (stage === 'pull') {
    const { loadModelAliases } = await import('./models/aliases.js');
    const failure = loadFailure(await loadModelAliases(localConfig));
    return failure ? failing(failure) : [];
  }

  const view = await loadView(ctx);
  if (!view) return [];
  const heldByCause = new Map<string, { reason: string; tools: Set<string>; agents: Set<string> }>();
  let usesAlias = false;
  const { isModelAlias } = await import('./models/aliases.js');
  for (const { name, spec } of view.agents) {
    usesAlias ||= isModelAlias(view.aliases, spec.model!);
    for (const { tool, resolution } of await resolutions(view, spec)) {
      if (resolution.ok) continue;
      const cause = heldByCause.get(resolution.reason) ?? { reason: resolution.reason, tools: new Set(), agents: new Set() };
      cause.tools.add(tool);
      cause.agents.add(name);
      heldByCause.set(resolution.reason, cause);
    }
  }

  const failure = loadFailure(view.aliases);
  if (failure) {
    // Every agent held meanwhile is held for that reason.
    const held = new Set([...heldByCause.values()].flatMap(({ agents }) => [...agents]));
    const named = held.size > 0 ? ` Held here: ${nameList([...held])}.` : '';
    return failing(`${failure}${named}`);
  }
  if (heldByCause.size > 0) {
    return failing([...heldByCause.values()].map(({ reason, tools, agents }) => {
      const where = [...tools].join(', ');
      return `In ${where}, ${reason}. Pull keeps the copies there of ${nameList([...agents])}, and writes none, until it can tell. `
        + `Repair the file the error names (or the settings file of ${where}), then run \`teamai pull\`.`;
    }).join(' '));
  }
  return usesAlias ? [{ name: CHECK_NAME, source: 'local', check: async () => true }] : [];
}

/**
 * Why no agent's model, or no alias agent's while only the member's file
 * fails, can be resolved, and what that holds.
 */
export function loadFailure(aliases: ModelAliases): string | undefined {
  if (!aliases.ok) {
    return `${aliases.reason}. Until that is fixed, pull keeps the deployed copies of every agent that sets a \`model\` and writes no new ones, `
      + 'and push skips those agents. Fix it, then run `teamai pull`.';
  }
  if (aliases.localFailure === undefined) return undefined;
  return `${aliases.localFailure}. Until that is fixed, pull keeps the deployed copies of every agent whose \`model\` is a model alias `
    + 'and writes no new ones, and push skips those agents; agents with a concrete model are not affected. Fix it, then run `teamai pull`.';
}

/**
 * Info lines for `doctor`: per agent that uses a model alias, what each
 * installed tool receives and which step decided it, so a member can answer
 * "why does Codex run this model". Agents with a concrete model, or none,
 * are written as their spec says and are left out. Agents and tools that
 * resolve alike share a line. Then every aliases entry this scope reads that
 * was dropped. Nothing is said while the aliases cannot be read: the check
 * above reports that.
 */
export async function agentModelNotes(ctx: DoctorContext): Promise<string[]> {
  const view = await loadView(ctx);
  if (!view?.aliases.ok) return [];
  const { isModelAlias } = await import('./models/aliases.js');

  const groups = new Map<string, { alias: string; agents: string[]; rows: string[] }>();
  for (const { name, spec } of view.agents) {
    const alias = spec.model!;
    if (!isModelAlias(view.aliases, alias)) continue;
    const byRow = new Map<string, ToolName[]>();
    for (const { tool, resolution } of await resolutions(view, spec)) {
      const row = await describeTool(spec, tool, resolution, view.records[name]?.[tool]);
      byRow.set(row, [...byRow.get(row) ?? [], tool]);
    }
    if (byRow.size === 0) continue;
    const rows = [...byRow].map(([row, tools]) => `    ${tools.join(', ')}: ${row}`);
    const key = `${alias}\n${rows.join('\n')}`;
    const group = groups.get(key) ?? { alias, agents: [], rows };
    group.agents.push(name);
    groups.set(key, group);
  }

  return [
    ...[...groups.values()].map(({ alias, agents, rows }) => (
      `models: how model: ${alias} resolves for agent${agents.length === 1 ? '' : 's'} ${nameList(agents)}:\n${rows.join('\n')}`)),
    ...view.aliases.warnings.map(({ message }) => message),
  ];
}

/**
 * `opus, effort high  [team: models/aliases.yaml]`: what `tool` receives,
 * then the step that decided it. The recorded copy is named when the last
 * pull deployed something else.
 */
async function describeTool(spec: AgentSpec, tool: ToolName, resolution: ModelResolution, recorded: RecordedAgentModel | undefined): Promise<string> {
  if (!resolution.ok) return `held, its copy is kept  [see the failing check "${CHECK_NAME}"]`;
  const { sameAgentModel } = await import('./resources/agents.js');
  const now = await describeModel(spec, tool, resolution);
  if (!recorded || sameAgentModel(recorded, resolution)) return now;
  return `${now}; the last pull deployed ${await describeModel(spec, tool, recorded)}, which \`teamai pull\` updates`;
}

async function describeModel(spec: AgentSpec, tool: ToolName, resolved: RecordedAgentModel): Promise<string> {
  const { agentEffortField, toolExtrasFor } = await import('./resources/agent-format.js');
  const { step, model, source } = resolved;
  const effortField = agentEffortField(tool);
  // An effort the tool's extras set is written after the alias's, and wins,
  // except on a switched tool, which receives none.
  const extrasEffort = effortField === undefined || step === 'switched' ? undefined : toolExtrasFor(spec, tool)?.[effortField];
  const effort = resolved.effort ?? (typeof extrasEffort === 'string' ? extrasEffort : undefined);

  let value = model ?? (step === 'local' ? `tool default (chosen in ${source})` : 'tool default');
  if (effort !== undefined) value += `, effort ${effort}`;
  // Codex keeps the effort of the session that starts a subagent whose file sets none.
  else if (model !== undefined && effortField === 'model_reasoning_effort') value += ', no effort, so the session\'s effort carries over';

  const why = (() => {
    switch (step) {
      case 'extras': return `extras: tool_extras.${tool} sets the model`;
      case 'switched': return model !== undefined
        ? `switched: ${tool} runs a model profile, which routes ${model}`
        : `switched: ${tool} runs a model profile and picks the model natively`;
      case 'local': return model !== undefined ? `local: ${source}` : 'local';
      case 'team': return `team: ${source}`;
      case 'default': return source !== undefined
        ? `default: ${source} does not map ${tool}`
        : `default: no active aliases file defines "${spec.model}"`;
      default: return step;
    }
  })();
  return `${value}  [${why}]`;
}

/**
 * Info lines for `doctor`: a model alias that agents this member receives use
 * is also defined in a `models/<ns>/aliases.yaml` whose `<ns>` their roles and
 * projects do not activate in `resources.models`. That file does not apply
 * here, which is right unless the activation was forgotten. Nothing is said
 * while the aliases cannot be read: the check above reports that.
 */
export async function aliasNamespaceNotes(ctx: DoctorContext): Promise<string[]> {
  const view = await loadView(ctx);
  if (!view?.aliases.ok || view.aliases.inactive.size === 0) return [];
  const { aliases } = view;

  const agentsByAlias = new Map<string, string[]>();
  for (const { name, spec } of view.agents) {
    const model = spec.model!;
    if (!aliases.inactive.has(model)) continue;
    agentsByAlias.set(model, [...agentsByAlias.get(model) ?? [], name]);
  }
  return [...agentsByAlias].flatMap(([alias, agents]) => (aliases.inactive.get(alias) ?? []).map(({ namespace, source }) => {
    const active = aliases.team.get(alias);
    const instead = active
      ? `"${alias}" comes from ${active.source} instead`
      : `no active team file maps "${alias}", so each tool uses its default model unless your local aliases file maps it`;
    return `models: alias "${alias}" in ${source}, used by agent${agents.length === 1 ? '' : 's'} ${nameList(agents)}, does not apply here, `
      + `as your roles and projects do not list "${namespace}" in resources.models: ${instead}. If it should apply, add `
      + `\`models: [${namespace}]\` to the resources of your role in manifest/roles.yaml or of your project in manifest/projects.yaml.`;
  }));
}
