import { KNOWN_AGENTS } from './known-agents.js';
import {
  isToolId, TOOLS,
  type CodebuddyConfigFile, type Evidence, type FirstExistingRead, type HomeMove, type HomeRead, type ProjectRead,
  type RunTime, type Support, type ToolDescriptor, type ToolFeatures,
} from './tools.js';
import { DEFAULT_TOOL_PATHS, type ToolId } from './types.js';

// ─── Generated support page ──────────────────────────────
//
//  docs/guide/tool-support.md and its Chinese page are rendered from
//  `TOOLS`, and a snapshot test regenerates and diffs them, so the page
//  cannot drift from the descriptor. Headers and the legend are
//  translated; cell text stays English on both pages (AGENTS.md).
//

/** Where each page is written, relative to the package root. */
export const TOOL_SUPPORT_PAGES = {
  en: 'docs/guide/tool-support.md',
  'zh-CN': 'docs/guide/zh-CN/tool-support.md',
} as const;

export type ToolSupportLang = keyof typeof TOOL_SUPPORT_PAGES;

const FEATURE_KEYS = ['env', 'workflows', 'recall', 'stats', 'aiBackend', 'votesJudge', 'agentHooks'] as const satisfies readonly (keyof ToolFeatures)[];

const TEXT = {
  en: {
    title: '# Tool support',
    intro: [
      'Where teamai writes each resource for each tool, and what the tool reads, as teamai\'s tool descriptor (`src/tools.ts`) records it.',
      'Generated: do not edit by hand. Regenerate with `npx vitest run tool-support -u` after changing the descriptor.',
    ],
    legend: [
      'A path is the place the tool reads, then the evidence for it: `v` a real tool run, or the tool\'s own loader run on teamai\'s output; `s` the tool\'s source; `d` its docs; `t` teamai\'s code only.',
      '`—` teamai writes nothing there: the tool has no such channel, or teamai does not use it. `?` unknown: teamai writes nothing there. `written; reads ?`: teamai writes the configured path, and where the tool reads is unknown.',
      'A home moves with the variable after it. A path under `~/<home>` follows the move.',
    ],
    user: '## User scope',
    project: '## Project scope',
    projectNote: 'Paths are relative to the project root. `cwd only`: the tool reads it only from a session started at the root. Hooks are the ones self mode writes; `user hooks` means it keeps the user-scope ones.',
    features: '## Run time and teamai\'s own AI',
    featuresNote: 'User scope, from #1221\'s matrix; a fix merged since is marked `t`, with a note. `✓` works. `◐` works by default, and a condition breaks it while doctor still reports it delivered. `✗` broken in the default setup. `+` the tool supports it and teamai does not build it. `—` the tool has no such feature. `?` unknown. The letter after the mark is the evidence, as above.',
    notes: 'Notes:',
    columns: {
      tool: 'Tool', home: 'Home', skills: 'Skills', rules: 'Rules', blocks: 'Instruction blocks', agents: 'Agents', hooks: 'Hooks', mcp: 'MCP', sessions: 'Sessions',
      env: 'Env', workflows: 'Workflows', recall: 'Recall', stats: 'Stats', aiBackend: 'AI backend', votesJudge: 'Votes judge', agentHooks: 'HTTP agent hooks',
    },
  },
  'zh-CN': {
    title: '# 工具支持',
    intro: [
      'teamai 为每个工具把每类资源写到哪里，以及工具读取哪里，以 teamai 的工具描述（`src/tools.ts`）为准。',
      '此文件由生成器生成，请勿手动编辑。修改描述后运行 `npx vitest run tool-support -u` 重新生成。',
    ],
    legend: [
      '路径是工具读取的位置，后面是依据：`v` 真实运行过该工具，或在 teamai 的输出上运行过工具自己的加载器；`s` 工具源码；`d` 工具文档；`t` 仅 teamai 自身代码。',
      '`—` teamai 不写入：工具没有这个通道，或 teamai 不使用它。`?` 未知：teamai 不写入。`written; reads ?`：teamai 写入配置的路径，但工具从哪里读取未知。',
      '主目录会随其后列出的变量移动，`~/<主目录>` 下的路径也跟着移动。',
    ],
    user: '## 用户范围',
    project: '## 项目范围',
    projectNote: '路径相对于项目根目录。`cwd only`：只有在根目录启动的会话才会读取。Hooks 一列是 self 模式写入的位置；`user hooks` 表示沿用用户范围的 hooks。',
    features: '## 运行时与 teamai 自身的 AI',
    featuresNote: '用户范围，取自 #1221 的矩阵；之后合入的修复标为 `t` 并附注。`✓` 可用。`◐` 默认可用，但某个条件会让它失效，而 doctor 仍报告已送达。`✗` 默认配置下不可用。`+` 工具支持，teamai 尚未实现。`—` 工具没有此功能。`?` 未知。标记后的字母是依据，含义同上。',
    notes: '注：',
    columns: {
      tool: '工具', home: '主目录', skills: '技能', rules: '规则', blocks: '指令块', agents: 'Agents', hooks: 'Hooks', mcp: 'MCP', sessions: '会话',
      env: '环境变量', workflows: '工作流', recall: 'Recall', stats: '统计', aiBackend: 'AI 后端', votesJudge: '投票评审', agentHooks: 'HTTP agent hooks',
    },
  },
} as const satisfies Record<ToolSupportLang, unknown>;

const EVIDENCE: Record<Evidence, string> = { verified: 'v', source: 's', docs: 'd', assumed: 't' };

type Read = HomeRead | ProjectRead | FirstExistingRead;

function file(path: string | CodebuddyConfigFile, base: 'home' | 'project'): string {
  if (typeof path !== 'string') return '`~/.codebuddy.json` (in `$CODEBUDDY_CONFIG_DIR` when set)';
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
    case 'xdg': return `\`$XDG_CONFIG_HOME/${move.child}\``;
    case 'win32-appdata': return `\`%LOCALAPPDATA%\\${move.child}\``;
    case 'profile-suffix': return `\`~/${dir}-$${move.name}\``;
    default: {
      const unhandled: never = move;
      return unhandled;
    }
  }
}

function home(descriptor: ToolDescriptor): string {
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

function userRow(tool: ToolId, d: ToolDescriptor): string[] {
  const { hooks } = d;
  return [
    name(tool),
    home(d),
    reads(d.skills.user),
    channel(d.rules.user, (c) => c.channel === 'inline' ? `in the blocks file (${c.label})` : reads(c.reads)),
    channel(d.blocks.user, (c) => reads(c.reads)),
    channel(d.agents.user, (c) => reads(c.reads)),
    channel(hooks.user, (c) => c.channel === 'settings' ? reads(c.reads) : `${c.adapter} ${EVIDENCE[c.evidence]}`),
    channel(d.mcp.user, (c) => reads(c.reads)),
    typeof d.sessions === 'string' ? channel(d.sessions, () => '') : d.sessions.join(', '),
  ];
}

function projectRow(tool: ToolId, d: ToolDescriptor): string[] {
  const { hooks } = d;
  return [
    name(tool),
    reads(d.skills.project),
    channel(d.rules.project, (c) => 'probe' in c ? runTime(c) : reads(c.reads)),
    channel(d.blocks.project, (c) => 'probe' in c ? runTime(c) : reads(c.reads)),
    channel(d.agents.project, (c) => reads(c.reads)),
    hooks.self === 'user' ? 'user hooks' : channel(hooks.self, (c) => reads(c.reads)),
    channel(d.mcp.project, (c) => reads(c.reads)),
  ];
}

function featureCell(support: Support, notes: string[]): string {
  if (typeof support === 'string') return support;
  if (!notes.includes(support.note)) notes.push(support.note);
  return `${support.cell}<sup>${notes.indexOf(support.note) + 1}</sup>`;
}

/** The support page in `lang`, rendered from `TOOLS`. */
export function renderToolSupportPage(lang: ToolSupportLang): string {
  const text = TEXT[lang];
  const c = text.columns;
  const tools = Object.keys(DEFAULT_TOOL_PATHS).filter(isToolId).map((tool): [ToolId, ToolDescriptor] => [tool, TOOLS[tool]]);
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
    ...table([c.tool, c.home, c.skills, c.rules, c.blocks, c.agents, c.hooks, c.mcp, c.sessions], tools.map(([tool, d]) => userRow(tool, d))),
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
  ].join('\n');
}
