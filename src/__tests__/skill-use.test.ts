/**
 * Skill use (#1221) through the real dispatcher and the real usage file, one
 * HOME per case. Payloads are the captured runs in fixtures/skill-use, with
 * paths replaced by ${HOME}/${CWD}.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDispatcher } from '../hook-dispatch.js';
import { buildHandlerRegistry } from '../hook-handlers.js';
import { isToolId, TOOLS } from '../tools.js';
import { DEFAULT_TOOL_PATHS, type LocalConfig } from '../types.js';
import { readUsageEvents } from '../usage-tracker.js';
import { sendWebhook } from '../webhook.js';

vi.mock('../webhook.js', () => ({
  sendWebhook: vi.fn().mockResolvedValue(undefined),
  loadWebhookConfig: vi.fn().mockResolvedValue({ enabled: true, endpoints: [{ url: 'http://127.0.0.1/hook' }] }),
}));

const FIXTURES = path.resolve(__dirname, 'fixtures', 'skill-use');
const SKILL = 'hello-skill';

let tmp: string;
let home: string;
let cwd: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  vi.mocked(sendWebhook).mockClear();
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-use-')));
  home = path.join(tmp, 'home');
  cwd = path.join(tmp, 'proj');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  process.env.HOME = home;
  // hook-dispatch runs its handlers in the hook's cwd.
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function config(): LocalConfig {
  return {
    repo: { localPath: path.join(home, '.teamai', 'team-repo'), remote: 'https://example.test/acme/team.git' },
    username: 'tester',
    scope: 'user',
    additionalRoles: [],
  };
}

/** The captures come from POSIX shells, where a Windows path is spelled with forward slashes. */
function posixPath(p: string): string {
  return p.replaceAll(path.sep, '/');
}

function fixture(name: string): Record<string, unknown> {
  const text = fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf-8')
    .replaceAll('${HOME}', posixPath(home))
    .replaceAll('${CWD}', posixPath(cwd));
  const payload: unknown = JSON.parse(text);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`${name} is not an object`);
  return { ...payload };
}

/** Install a skill under `root`, relative to HOME, or to the project with `project: true`. */
function install(root: string, options: { project?: boolean; skill?: string } = {}): string {
  const file = path.join(options.project ? cwd : home, root, options.skill ?? SKILL, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${options.skill ?? SKILL}\n`);
  return file;
}

const dispatcher = (localConfig = config()) => createDispatcher({ handlers: buildHandlerRegistry().filter((r) => r.handler.name.startsWith('skill-')), localConfig });

async function toolCall(payload: Record<string, unknown>, tool: string, matcher = '*', localConfig = config()): Promise<void> {
  const result = await dispatcher(localConfig).dispatch('post-tool-use', matcher, payload, tool, 'all');
  expect(result.errors).toEqual([]);
}

function writeTeamFile(relative: string, content: string): void {
  const file = path.join(config().repo.localPath, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function prompt(payload: Record<string, unknown>, tool: string): Promise<void> {
  const result = await dispatcher().dispatch('prompt-submit', '*', payload, tool, 'all');
  expect(result.errors).toEqual([]);
}

async function credits(): Promise<Array<{ skill: string; tool?: string }>> {
  return (await readUsageEvents(config())).map(({ skill, tool }) => ({ skill, tool }));
}

type ToolCallCase = { fixture: string; tool: string; root: string; project?: boolean };

/** One captured skill load per tool, credited once to that tool. */
const TOOL_CALL_CASES: ToolCallCase[] = [
  { fixture: 'claude-skill', tool: 'claude', root: '.claude/skills' },
  { fixture: 'codebuddy-skill', tool: 'codebuddy', root: '.codebuddy/skills' },
  { fixture: 'copilot-skill', tool: 'copilot', root: '.copilot/skills' },
  { fixture: 'muse-read-skill', tool: 'muse', root: '.config/muse/skills' },
  { fixture: 'opencode-skill', tool: 'opencode', root: '.config/opencode/skills' },
  { fixture: 'dsh-skill', tool: 'dsh', root: '.dsh/skills' },
  { fixture: 'cursor-real-read', tool: 'cursor', root: '.cursor/skills', project: true },
  { fixture: 'codex-real-a-cat', tool: 'codex', root: '.codex/skills' },
  { fixture: 'pi-read', tool: 'pi', root: '.pi/agent/skills' },
  { fixture: 'omp-read-uri', tool: 'omp', root: '.omp/agent/skills' },
];

describe('skill use from a tool call (#1221)', () => {
  it.each(TOOL_CALL_CASES)('$fixture credits $tool once', async ({ fixture: name, tool, root, project }) => {
    install(root, { project });
    await toolCall(fixture(name), tool);
    expect(await credits()).toEqual([{ skill: SKILL, tool }]);
  });

  it('has a captured case for every skill tool marked verified', () => {
    const covered = new Set(TOOL_CALL_CASES.map((c) => `${c.tool}:${String(fixture(c.fixture).tool_name)}`));
    const verified = Object.keys(DEFAULT_TOOL_PATHS).filter(isToolId).flatMap((tool) => {
      const load = TOOLS[tool].skillLoad;
      return load === 'unknown' ? [] : load.calls.filter((call) => call.evidence === 'verified').map((call) => `${tool}:${call.name}`);
    });
    expect(verified.filter((key) => !covered.has(key))).toEqual([]);
  });

  it('credits nothing for a tool whose skill loading is unknown (Hermes)', async () => {
    install('.hermes/skills');
    await toolCall(fixture('hermes-skill-view'), 'hermes');
    expect(await credits()).toEqual([]);
  });

  it('credits nothing for a skill that is not installed', async () => {
    await toolCall(fixture('claude-skill'), 'claude');
    await toolCall(fixture('codex-real-a-cat'), 'codex');
    expect(await credits()).toEqual([]);
  });

  it('credits nothing for a SKILL.md outside every skill root, or a plain file read', async () => {
    install('.claude/skills');
    const outside = path.join(tmp, 'docs', SKILL, 'SKILL.md');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, '# copy\n');
    const read = (file: string) => ({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: file } });
    await toolCall(read(outside), 'claude');
    await toolCall(read(path.join(cwd, 'README.md')), 'claude');
    expect(await credits()).toEqual([]);
  });

  it('counts a read of the shared ~/.agents/skills root', async () => {
    const file = install('.agents/skills');
    await toolCall({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: file } }, 'cursor');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'cursor' }]);
  });

  it('credits a custom tool for a skill installed under its toolPaths entry', async () => {
    writeTeamFile('teamai.yaml', 'team: acme\nrepo: https://example.test/acme/team.git\ntoolPaths:\n  acme:\n    skills: .acme/skills\n');
    install('.acme/skills');
    await toolCall({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: SKILL } }, 'acme');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'acme' }]);
  });

  it('credits a project skill read from a directory below the project root', async () => {
    const project: LocalConfig = { ...config(), scope: 'project', projectRoot: cwd };
    const file = install('.claude/skills', { project: true });
    const nested = path.join(cwd, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    await toolCall({ session_id: 's', cwd: nested, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: file } }, 'claude', '*', project);
    expect((await readUsageEvents(project)).map(({ skill, tool }) => ({ skill, tool }))).toEqual([{ skill: SKILL, tool: 'claude' }]);
  });

  it('credits `cat ~/…/SKILL.md`, the home the shell expands', async () => {
    install('.codex/skills');
    const payload = fixture('codex-real-a-cat');
    await toolCall({ ...payload, tool_input: { command: `cat ~/.codex/skills/${SKILL}/SKILL.md` } }, 'codex');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'codex' }]);
  });

  it('credits a double-quoted HOME skill read', async () => {
    install('.codex/skills');
    await toolCall({ ...fixture('codex-real-a-cat'), tool_input: { command: `cat "$HOME/.codex/skills/${SKILL}/SKILL.md"` } }, 'codex');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'codex' }]);
  });

  it('credits a Codex skill read inside a shell command list', async () => {
    const file = install('.codex/skills');
    await toolCall({ ...fixture('codex-real-a-cat'), tool_input: { command: `pwd; cat ${file}` } }, 'codex');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'codex' }]);
  });

  it('credits a Codex skill read on one line of a multi-line command', async () => {
    const file = install('.codex/skills');
    fs.writeFileSync(file, `---\nname: ${SKILL}\ndescription: d\n---\nbody\n`);
    const command = `sed -n '1,260p' ${file}\nrg -n -i "review|gate" ${path.join(home, '.codex', 'memories', 'MEMORY.md')}\nfind .scratch -maxdepth 3 -type f -name '*.md' -print | sort`;
    await toolCall({ ...fixture('codex-real-a-cat'), tool_input: { command }, tool_response: `${fs.readFileSync(file, 'utf8')}.scratch/notes.md\n` }, 'codex');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'codex' }]);
  });

  it('credits nothing for a relative skill read after a cd in a multi-line command', async () => {
    install('.claude/skills', { project: true });
    const command = `cd ${path.join(tmp, 'other')}\nsed -n '1,260p' .claude/skills/${SKILL}/SKILL.md\nrg -n gate notes.md`;
    await toolCall({ ...fixture('claude-skill'), tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: `# ${SKILL}\n`, stderr: '' } }, 'claude');
    expect(await credits()).toEqual([]);
  });

  it('credits a Claude Bash skill read guarded by a test', async () => {
    const file = install('.claude/skills');
    await toolCall({ ...fixture('claude-skill'), tool_name: 'Bash', tool_input: { command: `test -f ${file} && cat ${file}` }, tool_response: { stdout: `# ${SKILL}\n`, stderr: '' } }, 'claude');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'claude' }]);
  });

  it('credits nothing for a skill read after || that the command shows may not run', async () => {
    const file = install('.claude/skills');
    await toolCall({ ...fixture('claude-skill'), tool_name: 'Bash', tool_input: { command: `true || cat ${file}` }, tool_response: { stdout: '', stderr: '' } }, 'claude');
    expect(await credits()).toEqual([]);
  });

  it.each([
    ['nothing for a read after && the command skipped', 'false && cat FILE; true', '', []],
    ['a read after && that ran', 'test -f FILE && cat FILE; echo done', 'SHOWN\ndone\n', [SKILL]],
    ['a read after || that ran', 'test -f /missing || cat FILE; true', 'SHOWN', [SKILL]],
    ['nothing for a read after || that did not run, whose output names the skill only inside a line', `true || cat FILE; printf 'description: "name: ${SKILL}"\\n'`, `description: "name: ${SKILL}"\n`, []],
  ])('credits %s, as the output shows', async (_, command, stdout, skills) => {
    const file = install('.claude/skills');
    const shown = `---\nname: ${SKILL}\ndescription: d\n---\nbody\n`;
    fs.writeFileSync(file, shown);
    await toolCall({ ...fixture('claude-skill'), tool_name: 'Bash', tool_input: { command: command.replaceAll('FILE', file) }, tool_response: { stdout: stdout.replace('SHOWN', shown), stderr: '' } }, 'claude');
    expect(await credits()).toEqual(skills.map((skill) => ({ skill, tool: 'claude' })));
  });

  it('credits a skill read before &&', async () => {
    const file = install('.claude/skills');
    await toolCall({ ...fixture('claude-skill'), tool_name: 'Bash', tool_input: { command: `cat ${file} && echo ok` }, tool_response: { stdout: `# ${SKILL}\nok\n`, stderr: '' } }, 'claude');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'claude' }]);
  });

  it('credits a skill read after ;', async () => {
    const file = install('.claude/skills');
    await toolCall({ ...fixture('claude-skill'), tool_name: 'Bash', tool_input: { command: `cd ${tmp}; cat ${file}` }, tool_response: { stdout: `# ${SKILL}\n`, stderr: '' } }, 'claude');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'claude' }]);
  });

  it('credits nothing when a skill path only appears inside a heredoc body', async () => {
    const file = install('.codex/skills');
    await toolCall({ ...fixture('codex-real-a-cat'), tool_input: { command: `cat <<'EOF'\ncat ${file}\nEOF` } }, 'codex');
    expect(await credits()).toEqual([]);
  });

  it('gates a named Skill call on its calling tool but accepts a real read from another tool root', async () => {
    const file = install('.pi/agent/skills');
    await toolCall(fixture('claude-skill'), 'claude');
    expect(await credits()).toEqual([]);
    await toolCall({ ...fixture('claude-skill'), tool_name: 'Read', tool_input: { file_path: file } }, 'claude');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'claude' }]);
  });

  it('credits a custom tool id for a Skill call only, after normalizeToolName', async () => {
    writeTeamFile('teamai.yaml', 'team: acme\nrepo: https://example.test/acme/team.git\ntoolPaths:\n  acme-agent:\n    skills: .acme/skills\n');
    const file = install('.acme/skills');
    await toolCall({ hook_event_name: 'PostToolUse', tool_name: 'skill', tool_input: { skill: SKILL } }, 'acme-agent');
    await toolCall({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: file } }, 'acme-agent');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'acme-agent' }]);
  });

  it('still counts an OpenCode `Skill` from a plugin loaded before the upgrade', async () => {
    install('.config/opencode/skills');
    await toolCall({ ...fixture('opencode-skill'), tool_name: 'Skill' }, 'opencode');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'opencode' }]);
  });

  it('runs on the wildcard pass only: a stale `--matcher Skill` hook credits nothing', async () => {
    install('.claude/skills');
    await toolCall(fixture('claude-skill'), 'claude', 'Skill');
    expect(await credits()).toEqual([]);
  });

  it('records nothing when the team disables the retired Skill built-in', async () => {
    install('.claude/skills');
    writeTeamFile('hooks/hooks.yaml', 'builtin:\n  disabled:\n    - Hook dispatch post-tool-use Skill\n');
    await toolCall(fixture('claude-skill'), 'claude');
    expect(await credits()).toEqual([]);
  });

  it('still counts when the builtin block disables only other built-ins', async () => {
    install('.claude/skills');
    writeTeamFile('hooks/hooks.yaml', 'builtin:\n  disabled:\n    - Hook dispatch session-start\n');
    await toolCall(fixture('claude-skill'), 'claude');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'claude' }]);
  });

  it('still counts when an invalid builtin block does not list it', async () => {
    install('.claude/skills');
    writeTeamFile('hooks/hooks.yaml', 'builtin:\n  overrides:\n    Hook dispatch session-start:\n      timeout: "30"\n');
    await toolCall(fixture('claude-skill'), 'claude');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'claude' }]);
  });

  it('records nothing when an invalid builtin block lists it', async () => {
    install('.claude/skills');
    writeTeamFile('hooks/hooks.yaml', 'builtin:\n  disabled:\n    - Hook dispatch post-tool-use Skill\n  overrides:\n    Hook dispatch session-start:\n      timeout: "30"\n');
    await toolCall(fixture('claude-skill'), 'claude');
    expect(await credits()).toEqual([]);
  });

  it('records nothing when hooks.yaml is not a readable file', async () => {
    install('.claude/skills');
    fs.mkdirSync(path.join(config().repo.localPath, 'hooks', 'hooks.yaml'), { recursive: true });
    await toolCall(fixture('claude-skill'), 'claude');
    expect(await credits()).toEqual([]);
  });

  it('records nothing when a hooks.yaml that disables it cannot be read', async () => {
    install('.claude/skills');
    writeTeamFile('hooks/hooks.yaml', 'builtin:\n  disabled:\n    - Hook dispatch post-tool-use Skill\nhooks: [\n');
    await toolCall(fixture('claude-skill'), 'claude');
    expect(await credits()).toEqual([]);
  });

  it('still counts when hooks.yaml has an invalid team hook and no builtin block', async () => {
    install('.claude/skills');
    writeTeamFile('hooks/hooks.yaml', 'hooks:\n  - id: lint\n    event: PostToolUse\n    command: echo hi\n');
    await toolCall(fixture('claude-skill'), 'claude');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'claude' }]);
  });

  it('records nothing when a valid builtin block disables it beside an invalid team hook', async () => {
    install('.claude/skills');
    writeTeamFile('hooks/hooks.yaml', 'builtin:\n  disabled:\n    - Hook dispatch post-tool-use Skill\nhooks:\n  - id: lint\n    event: PostToolUse\n    command: echo hi\n');
    await toolCall(fixture('claude-skill'), 'claude');
    expect(await credits()).toEqual([]);
  });
});

describe('skill use from a prompt mention (#1221)', () => {
  it('credits a Codex `$name` mention', async () => {
    install('.codex/skills');
    await prompt(fixture('codex-real-b-mention'), 'codex');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'codex' }]);
  });

  it('gates Codex mentions on Codex installations', async () => {
    install('.pi/agent/skills', { skill: 'pi-only' });
    const payload = { session_id: 'own-roots', turn_id: 'T1', prompt: '$pi-only', cwd };
    await prompt(payload, 'codex');
    expect(await credits()).toEqual([]);
    install('.codex/skills', { skill: 'pi-only' });
    await prompt(payload, 'codex');
    expect(await credits()).toEqual([{ skill: 'pi-only', tool: 'codex' }]);
  });

  it.each(['claude', 'codex'])('uses the recorded relocated %s root for prompt mentions', async (tool) => {
    const root = path.join(home, `.${tool}-work`);
    const localConfig = { ...config(), toolRoots: { [tool]: root } };
    install(`.${tool}-work/skills`);
    const result = await dispatcher(localConfig).dispatch('prompt-submit', '*', {
      session_id: 'relocated', cwd, prompt: `${tool === 'codex' ? '$' : '/'}${SKILL}`,
    }, tool, 'all');
    expect(result.errors).toEqual([]);
    expect(await credits()).toEqual([{ skill: SKILL, tool }]);
  });

  it('uses COPILOT_HOME for a named skill call', async () => {
    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = path.join(home, 'copilot-alt');
    try {
      install('copilot-alt/skills');
      await toolCall(fixture('copilot-skill'), 'copilot');
      expect(await credits()).toEqual([{ skill: SKILL, tool: 'copilot' }]);
    } finally {
      if (previous === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previous;
    }
  });

  it('uses custom project and userScope paths for mentions', async () => {
    writeTeamFile('teamai.yaml', 'team: acme\nrepo: https://example.test/acme/team.git\ntoolPaths:\n  acme:\n    skills: .acme/skills\n    userScope:\n      skills: .acme-user/skills\n');
    install('.acme-user/skills', { skill: 'user-only' });
    install('.acme/skills', { project: true, skill: 'project-only' });
    for (const skill of ['user-only', 'project-only']) {
      await prompt({ session_id: skill, cwd, prompt: `/${skill}` }, 'acme');
    }
    expect(await credits()).toEqual([{ skill: 'user-only', tool: 'acme' }, { skill: 'project-only', tool: 'acme' }]);
  });

  it.each(['codex', 'muse', 'claude'])('retains shared .agents/skills for %s mentions', async (tool) => {
    install('.agents/skills');
    await prompt({ session_id: 'shared', cwd, prompt: `${tool === 'codex' ? '$' : '/'}${SKILL}` }, tool);
    expect(await credits()).toEqual([{ skill: SKILL, tool }]);
  });

  it.each(['muse', 'opencode'])('retains native Claude skill discovery for %s', async (tool) => {
    install('.claude/skills');
    await prompt({ session_id: 'native-shared', cwd, prompt: `/${SKILL}` }, tool);
    expect(await credits()).toEqual([{ skill: SKILL, tool }]);
  });

  it('gates even a Pi prompt block with a file on Pi roots', async () => {
    const file = install('.codex/skills');
    await prompt({ session_id: 'pi-cross-root', cwd, prompt: `<skill name="${SKILL}" location="${file}">\n# copy\n</skill>` }, 'pi');
    expect(await credits()).toEqual([]);
  });

  it('credits the skill block Pi expands `/skill:name` into', async () => {
    install('.pi/agent/skills');
    await prompt(fixture('pi-mention'), 'pi');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'pi' }]);
  });

  it('credits nothing for a Pi skill block whose file is outside every skill root', async () => {
    install('.pi/agent/skills');
    const outside = path.join(tmp, 'docs', SKILL, 'SKILL.md');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, '# copy\n');
    await prompt({ cwd, session_id: 'pi-run', prompt: `<skill name="${SKILL}" location="${outside}">\n# copy\n</skill>` }, 'pi');
    expect(await credits()).toEqual([]);
  });

  it('credits `/name` at the start of the prompt for a tool without its own prefix', async () => {
    install('.claude/skills');
    await prompt({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: `/${SKILL} go` }, 'claude');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'claude' }]);
  });

  it('skips the generic `/name` for a tool with its own prefix, and an uninstalled `$HOME`', async () => {
    install('.codex/skills');
    install('.pi/agent/skills');
    await prompt({ session_id: 'c', hook_event_name: 'UserPromptSubmit', prompt: `/${SKILL} echo $HOME` }, 'codex');
    await prompt({ session_id: 'p', hook_event_name: 'UserPromptSubmit', prompt: `/${SKILL}` }, 'pi');
    expect(await credits()).toEqual([]);
  });
});

describe('one credit per session turn (#1221)', () => {
  it('sends one webhook after a slash prompt already credited the skill', async () => {
    install('.claude/skills');
    const call = fixture('claude-skill');
    await prompt({ ...call, prompt: `/${SKILL}` }, 'claude');
    expect(sendWebhook).not.toHaveBeenCalled();
    await toolCall(call, 'claude');
    await toolCall(call, 'claude');
    expect(await credits()).toHaveLength(1);
    expect(sendWebhook).toHaveBeenCalledTimes(1);
    expect(sendWebhook).toHaveBeenCalledWith('skill-use', expect.objectContaining({ data: { skillName: SKILL } }), expect.anything());
    await prompt({ ...call, prompt_id: 'next', prompt: `/${SKILL}` }, 'claude');
    await toolCall({ ...call, prompt_id: 'next' }, 'claude');
    expect(await credits()).toHaveLength(2);
    expect(sendWebhook).toHaveBeenCalledTimes(2);
  });

  it('sends one webhook for two cat reads in a turn and sends again in the next turn', async () => {
    install('.codex/skills');
    const call = fixture('codex-real-c-cat');
    await toolCall(call, 'codex');
    await toolCall(call, 'codex');
    expect(sendWebhook).toHaveBeenCalledTimes(1);
    await toolCall({ ...call, turn_id: 'next' }, 'codex');
    expect(sendWebhook).toHaveBeenCalledTimes(2);
    expect(await credits()).toHaveLength(2);
  });

  it('counts a Codex mention and a read of the same skill in one turn once', async () => {
    install('.codex/skills');
    await prompt(fixture('codex-real-c-mention'), 'codex');
    await toolCall(fixture('codex-real-c-cat'), 'codex');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'codex' }]);
  });

  it('counts a Claude Skill call and a Read of its SKILL.md in one turn once', async () => {
    const file = install('.claude/skills');
    const skillCall = fixture('claude-skill');
    await toolCall(skillCall, 'claude');
    await toolCall({ ...skillCall, tool_name: 'Read', tool_input: { file_path: file } }, 'claude');
    expect(await credits()).toEqual([{ skill: SKILL, tool: 'claude' }]);
  });

  it('counts `/name` then the Skill call once, using the prompt-submit stamp when the host sends no turn id', async () => {
    install('.claude/skills');
    const base = { session_id: 'stamped', cwd };
    await prompt({ ...base, hook_event_name: 'UserPromptSubmit', prompt: `/${SKILL}` }, 'claude');
    await toolCall({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: SKILL } }, 'claude');
    expect(await credits()).toHaveLength(1);
  });

  it('counts the same skill again in the next turn', async () => {
    install('.claude/skills');
    const base = { session_id: 'two-turns', cwd };
    const skillCall = { ...base, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: SKILL } };
    for (const text of ['first', 'second']) {
      await prompt({ ...base, hook_event_name: 'UserPromptSubmit', prompt: text }, 'claude');
      await toolCall(skillCall, 'claude');
      await toolCall(skillCall, 'claude');
    }
    expect(await credits()).toHaveLength(2);
  });

  it('counts a Skill call sent without the turn id its host gave the prompt, in a later turn', async () => {
    install('.claude/skills');
    const base = { session_id: 'late-id', cwd, hook_event_name: 'UserPromptSubmit' };
    await prompt({ ...base, prompt_id: 'T1', prompt: `/${SKILL} go` }, 'claude');
    await prompt({ ...base, prompt_id: 'T2', prompt: 'no mention' }, 'claude');
    await toolCall({ session_id: 'late-id', cwd, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: SKILL } }, 'claude');
    expect(await credits()).toHaveLength(2);
  });

  it('counts every call when there is no turn key: no host id and no prompt-submit stamp', async () => {
    install('.claude/skills');
    const skillCall = { session_id: 'no-turn', cwd, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: SKILL } };
    await toolCall(skillCall, 'claude');
    await toolCall(skillCall, 'claude');
    expect(await credits()).toHaveLength(2);
  });

  it('writes no claims file for a prompt that names no skill when the host sends a turn id', async () => {
    await prompt({ ...fixture('codex-real-c-mention'), prompt: 'no skill here' }, 'codex');
    expect(fs.existsSync(path.join(home, '.teamai'))).toBe(false);
    await prompt({ session_id: 'stamp-only', hook_event_name: 'UserPromptSubmit', prompt: 'no skill here' }, 'claude');
    expect(fs.readdirSync(path.join(home, '.teamai', 'sessions'))).toEqual(['stamp-only-skills.json']);
  });

  it('writes no claims file for a Codex prompt whose `$HOME` is no installed skill', async () => {
    await prompt({ ...fixture('codex-real-c-mention'), prompt: 'echo $HOME' }, 'codex');
    expect(fs.existsSync(path.join(home, '.teamai', 'sessions'))).toBe(false);
  });

  it('keeps one claims file per session, which the session sweep reaches', async () => {
    install('.claude/skills');
    await toolCall(fixture('claude-skill'), 'claude');
    expect(fs.readdirSync(path.join(home, '.teamai', 'sessions'))).toEqual(['claude-run-skills.json']);
  });
});
