import { KNOWN_AGENTS } from '../src/known-agents.js';
import { type ToolId, type ShippedDescriptor } from '../src/tools.js';
import { type CodebuddyConfigFile, type Evidence, type FirstExistingRead, type HomeMove, type HomeRead, type ProjectRead, type RunTime, type Support, type ToolFeatures } from '@teamai/tool-core/definition';
import { isToolId, descriptorOf, INSTANCE_BASES } from '../src/tool-registry.js';
import { DEFAULT_TOOL_PATHS } from '../src/types.js';
import { deliveredHomeVariableOf } from '../src/tool-launch/tools.js';

// ─── Generated support page ──────────────────────────────
//
//  docs/guide/tool-support.md and its Chinese page are rendered from
//  `TOOLS`, and the documentation command regenerates and diffs them, so the page
//  cannot drift from the descriptor. Headers and the legend are
//  translated; cell text stays English on both pages (AGENTS.md).
//

/** Where each page is written, relative to the package root. */
export const TOOL_SUPPORT_PAGES = {
  en: 'docs/guide/tool-support.md',
  'zh-CN': 'docs/guide/zh-CN/tool-support.md',
} as const;

export type ToolSupportLang = keyof typeof TOOL_SUPPORT_PAGES;

const FEATURE_KEYS = ['env', 'workflows', 'unattended', 'recall', 'stats', 'tokens', 'aiBackend', 'sessionJudge', 'agentHooks'] as const satisfies readonly (keyof ToolFeatures)[];

/** The translated headers, legend and column names of one support page. */
type PageText = {
  readonly title: string;
  readonly intro: readonly string[];
  readonly legend: readonly string[];
  readonly user: string;
  readonly userNote: string;
  readonly project: string;
  readonly projectNote: string;
  readonly features: string;
  readonly featuresNote: string;
  readonly notes: string;
  readonly instances: string;
  readonly instancesNote: string;
  readonly stepHomes: string;
  readonly stepHomesNote: string;
  readonly columns: Readonly<Record<'tool' | 'home' | 'skills' | 'rules' | 'folderReach' | 'blocks' | 'agents' | 'hooks' | 'mcp' | 'sessions' | (typeof FEATURE_KEYS)[number], string>>;
};

const TEXT = {
  en: {
    title: '# Tool support',
    intro: [
      'Where teamai writes each agent resource for each tool, and what the tool reads, as teamai\'s tool descriptor (`src/tools.ts`) records it.',
      'Generated: do not edit by hand. Regenerate with `node scripts/check-docs.mjs --write` after changing the descriptor.',
    ],
    legend: [
      'A path is the place the tool reads, then the evidence for it: `v` a real tool run, or the tool\'s own loader run on teamai\'s output; `s` the tool\'s source; `d` its docs; `t` teamai\'s code only.',
      '`—` teamai writes nothing there: the tool has no such channel, or teamai does not use it. `?` unknown: teamai writes nothing there. `written; reads ?`: teamai writes the configured path, and where the tool reads is unknown.',
      'A home moves with the variable after it. A path under `~/<home>` follows the move.',
    ],
    user: '## User scope',
    userNote: 'Rule and agent folder files: how the tool reads the files a user-scope rule or agent folder names in the data home: `none` with no prompt, `grant` once teamai adds that directory to the setting named, `copy`: it may ask, and pull warns once. In a project every tool reads them in the worktree.',
    project: '## Project scope',
    projectNote: 'Paths are relative to the project root. `cwd only`: the tool reads it only from a session started at the root. Hooks are the ones self mode writes; `user hooks` means it keeps the user-scope ones.',
    features: '## Run time and teamai\'s own AI',
    featuresNote: 'User scope, from #1221\'s matrix; a fix merged since is marked `t`, with a note. `✓` works. `◐` works by default, and a condition breaks it while doctor still reports it delivered. `✗` broken in the default setup. `+` the tool supports it and teamai does not build it. `—` the tool has no such feature. `?` unknown. The letter after the mark is the evidence, as above.',
    notes: 'Notes:',
    instances: '## Tool instances',
    instancesNote: 'A team or a member adds an [instance](./reference.md#team-tools-tools) of these tools only, and teamai refuses an instance of any other tool:',
    stepHomes: '## Workflow steps at a moved home',
    stepHomesNote: 'A workflow step on one of these tools starts it with the variable after it set to the home teamai delivered to, the root `init` recorded (`toolRoots`) or the [recorded home](./reference.md#recorded-tool-homes-teamaitool-homesjson), even from a shell without that variable or one that names another directory. When a recorded directory is gone, the step does not start the tool and its failure says how to fix the record. Any other tool starts with the shell\'s variables, so start its run from a shell that sets them:',
    columns: {
      tool: 'Tool', home: 'Home', skills: 'Skills', rules: 'Rules', folderReach: 'Rule and agent folder files', blocks: 'Instruction blocks', agents: 'Agents', hooks: 'Hooks', mcp: 'MCP', sessions: 'Sessions',
      env: 'Env', workflows: 'Workflows (local driver)', unattended: 'Unattended prompts', recall: 'Recall', stats: 'Stats', tokens: 'Tokens & cost', aiBackend: 'AI backend', sessionJudge: 'Session judge', agentHooks: 'HTTP agent hooks',
    },
  },
  'zh-CN': {
    title: '# 工具支持',
    intro: [
      'teamai 为每个工具把每类 Agent 资源写到哪里，以及工具读取哪里，以 teamai 的工具描述（`src/tools.ts`）为准。',
      '此文件由生成器生成，请勿手动编辑。修改描述后运行 `node scripts/check-docs.mjs --write` 重新生成。',
    ],
    legend: [
      '路径是工具读取的位置，后面是依据：`v` 真实运行过该工具，或在 teamai 的输出上运行过工具自己的加载器；`s` 工具源码；`d` 工具文档；`t` 仅 teamai 自身代码。',
      '`—` teamai 不写入：工具没有这个通道，或 teamai 不使用它。`?` 未知：teamai 不写入。`written; reads ?`：teamai 写入配置的路径，但工具从哪里读取未知。',
      '主目录会随其后列出的变量移动，`~/<主目录>` 下的路径也跟着移动。',
    ],
    user: '## 用户范围',
    userNote: '规则与 agent 文件夹的文件：工具如何读取用户范围的规则或 agent 文件夹在数据目录中引用的文件：`none` 无需确认，`grant` 在 teamai 把该目录加入所列设置后读取，`copy` 可能会先询问，pull 会提示一次。在项目中，所有工具都从工作树读取这些文件。',
    project: '## 项目范围',
    projectNote: '路径相对于项目根目录。`cwd only`：只有在根目录启动的会话才会读取。Hooks 一列是 self 模式写入的位置；`user hooks` 表示沿用用户范围的 hooks。',
    features: '## 运行时与 teamai 自身的 AI',
    featuresNote: '用户范围，取自 #1221 的矩阵；之后合入的修复标为 `t` 并附注。`✓` 可用。`◐` 默认可用，但某个条件会让它失效，而 doctor 仍报告已送达。`✗` 默认配置下不可用。`+` 工具支持，teamai 尚未实现。`—` 工具没有此功能。`?` 未知。标记后的字母是依据，含义同上。',
    notes: '注：',
    instances: '## 工具实例',
    instancesNote: '团队或成员只能为以下工具添加[实例](./reference.md#团队工具tools)，teamai 拒绝其他任何工具的实例：',
    stepHomes: '## 在迁移后的主目录启动的工作流步骤',
    stepHomesNote: '工作流步骤在以下工具上启动时，即使 shell 没有设其后列出的变量，或把它设为另一个目录，也会把它设为 teamai 写入的主目录：`init` 记录的根目录（`toolRoots`），或[记录的主目录](./reference.md#记录的工具主目录teamaitool-homesjson)。记录的目录不存在时，步骤不会启动该工具，失败信息会说明如何修正记录。其他工具沿用 shell 的变量，所以请在设了这些变量的 shell 里启动运行：',
    columns: {
      tool: '工具', home: '主目录', skills: '技能', rules: '规则', folderReach: '规则与 agent 文件夹的文件', blocks: '指令块', agents: 'Agents', hooks: 'Hooks', mcp: 'MCP', sessions: '会话',
      env: '环境变量', workflows: '工作流（本地驱动）', unattended: '无人值守提示', recall: 'Recall', stats: '统计', tokens: 'Token 与费用', aiBackend: 'AI 后端', sessionJudge: '会话评审', agentHooks: 'HTTP agent hooks',
    },
  },
} as const satisfies Record<ToolSupportLang, PageText>;

const EVIDENCE: Record<Evidence, string> = { verified: 'v', source: 's', docs: 'd', assumed: 't' };

type Read = HomeRead | ProjectRead | FirstExistingRead;

function file(path: string | CodebuddyConfigFile, base: 'home' | 'project'): string {
  if (path instanceof Object) return '`~/.codebuddy.json` (in `$CODEBUDDY_CONFIG_DIR` when set)';

  return base === 'home' ? `\`~/${path}\`` : `\`${path}\``;
}

function read(entry: Read): string {
  const where = 'firstOf' in entry
    ? `first of ${entry.firstOf.map((path) => file(path, entry.base)).join(', ')}`
    : file(entry.path, entry.base);

  const when = 'when' in entry && entry.when === 'cwdOnly' ? ' cwd only'
    : 'when' in entry && entry.when === 'workspaceUnderHome' ? ' from a session under ~' : '';

  return `${where} ${EVIDENCE[entry.evidence]}${when}`;
}

function reads(list: readonly Read[] | 'unknown'): string {
  return list === 'unknown' ? 'written; reads ?' : list.map(read).join('<br>');
}

/** A scope's channel: `—` and `?` as stated, else the places the tool reads. */
function channel<C>(value: C | 'none' | 'unknown', render: (c: C) => string): string {
  if (value === 'none') return '—';

  if (value === 'unknown') return '?';

  return render(value);
}

function runTime(value: RunTime): string {
  return `${value.channel.replace('-', ' ')} ${EVIDENCE[value.evidence]}`;
}

function homeMove(move: HomeMove, dir: string): string {
  switch (move.kind) {
    case 'env': return `\`$${move.name}\``;
    case 'qoder-home': return '`$QODER_CONFIG_DIR` `$QODER_CLI_HOME/.qoder`';
    case 'qoder-cn-home': return '`$QODERCN_CONFIG_DIR` `$QODERCN_CLI_HOME/.qoder-cn`';
    case 'xdg': return `\`$XDG_CONFIG_HOME/${move.child}\``;
    case 'openclaw-state': return `\`$OPENCLAW_STATE_DIR\` \`$OPENCLAW_HOME/${dir}[-$OPENCLAW_PROFILE]\``;
    case 'omp-agent': return '`~/$PI_CONFIG_DIR/agent` `~/$PI_CONFIG_DIR/profiles/$OMP_PROFILE/agent` (or `$PI_PROFILE`)';
    case 'hermes-home': return `\`$HERMES_HOME\` \`~/${dir}$HERMES_DATA_DIR_SUFFIX\` \`%LOCALAPPDATA%\\hermes$HERMES_DATA_DIR_SUFFIX\` \`<home>/profiles/<active_profile>\``;
    default: {
      const unhandled: never = move;

      return unhandled;
    }
  }
}

function home(descriptor: ShippedDescriptor): string {
  const { dir, moves } = descriptor.home;

  return [`\`~/${moves?.root ?? dir}\``, ...(moves?.by.map((move) => homeMove(move, dir)) ?? [])].join(' ');
}

function name(tool: ToolId): string {
  return KNOWN_AGENTS.find((agent) => agent.id === tool)?.displayName ?? tool;
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [row(header), row(header.map(() => '---')), ...rows.map(row)];
}

function agentsRead(d: ShippedDescriptor, scope: 'user' | 'project'): string {
  const value = d.agents[scope];

  if (value === 'none') return '—';

  if (value === 'unknown') return '?';
  const result = reads(value.reads);

  return d === descriptorOf('joycode') ? `${result}<br>indexed by \`agent.json\`` : result;
}

function userRow(tool: ToolId, d: ShippedDescriptor): string[] {
  const { hooks } = d;

  return [
    name(tool),
    home(d),
    reads(d.skills.user),
    channel(d.rules.user, (c) => c.channel === 'inline' ? `in the blocks file (${c.label})` : reads(c.reads)),
    folderReach(d),
    channel(d.blocks.user, (c) => reads(c.reads)),
    agentsRead(d, 'user'),
    channel(hooks.user, (c) => c.channel === 'settings' ? reads(c.reads) : `${c.adapter} ${EVIDENCE[c.evidence]}`),
    channel(d.mcp.user, (c) => reads(c.reads)),
    Array.isArray(d.sessions) ? d.sessions.join(', ') : channel(d.sessions, () => ''),
  ];
}

function projectRow(tool: ToolId, d: ShippedDescriptor): string[] {
  const { hooks } = d;

  return [
    name(tool),
    reads(d.skills.project),
    channel(d.rules.project, (c) => 'probe' in c ? runTime(c) : reads(c.reads)),
    channel(d.blocks.project, (c) => 'probe' in c ? runTime(c) : reads(c.reads)),
    agentsRead(d, 'project'),
    hooks.self === 'user' ? 'user hooks' : channel(hooks.self, (c) => reads(c.reads)),
    channel(d.mcp.project, (c) => reads(c.reads)),
  ];
}

function folderReach(d: ShippedDescriptor): string {
  const cell = d.folderReach ?? { reach: 'copy' };

  switch (cell.reach) {
    case 'none': return `none ${EVIDENCE[cell.evidence]}`;
    case 'grant': return `grant \`${cell.setting}\` ${EVIDENCE[cell.evidence]}`;
    case 'copy': return cell.evidence === undefined ? 'copy' : `copy ${EVIDENCE[cell.evidence]}`;
    default: {
      const unhandled: never = cell;

      return unhandled;
    }
  }
}

function featureCell(support: Support, notes: string[]): string {
  if (!(support instanceof Object)) return support;

  if (!notes.includes(support.note)) notes.push(support.note);

  return `${support.cell}<sup>${notes.indexOf(support.note) + 1}</sup>`;
}

/** The support page in `lang`, rendered from `TOOLS`. */
export function renderToolSupportPage(lang: ToolSupportLang): string {
  const text = TEXT[lang];
  const c = text.columns;
  const tools = Object.keys(DEFAULT_TOOL_PATHS).filter(isToolId).map((tool): [ToolId, ShippedDescriptor] => [tool, descriptorOf(tool)]);
  const notes: string[] = [];
  const featureRows = tools.map(([tool, d]) => [name(tool), ...FEATURE_KEYS.map((key) => featureCell(d.features[key], notes))]);

  return [
    text.title,
    '',
    ...text.intro.flatMap((line) => [line, '']),
    ...text.legend.flatMap((line) => [`- ${line}`]),
    '',
    text.user,
    '',
    text.userNote,
    '',
    ...table([c.tool, c.home, c.skills, c.rules, c.folderReach, c.blocks, c.agents, c.hooks, c.mcp, c.sessions], tools.map(([tool, d]) => userRow(tool, d))),
    '',
    text.project,
    '',
    text.projectNote,
    '',
    ...table([c.tool, c.skills, c.rules, c.blocks, c.agents, c.hooks, c.mcp], tools.map(([tool, d]) => projectRow(tool, d))),
    '',
    text.features,
    '',
    text.featuresNote,
    '',
    ...table([c.tool, ...FEATURE_KEYS.map((key) => c[key])], featureRows),
    '',
    text.notes,
    '',
    ...notes.map((note, i) => `${i + 1}. ${note}`),
    '',
    text.instances,
    '',
    text.instancesNote,
    '',
    ...INSTANCE_BASES.map((tool) => `- ${name(tool)} (\`${tool}\`)`),
    '',
    text.stepHomes,
    '',
    text.stepHomesNote,
    '',
    ...tools.flatMap(([tool]) => {
      const variable = deliveredHomeVariableOf(tool);

      return variable === undefined ? [] : [`- ${name(tool)} (\`${tool}\`): \`${variable}\``];
    }),
    '',
  ].join('\n');
}
