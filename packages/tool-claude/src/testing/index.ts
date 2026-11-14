import fs from 'node:fs';
import { claudeProjectDirName } from '@teamai/tool-core/sessions/fs';

const recorded = (name: string): string => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8').trim();

/**
 * How a fake `claude` answers, for `fakeAgent` of @teamai/tool-testing: the call `claude -p` printed for real, as one
 * result object or, with `--output-format stream-json`, after an init and an assistant line. A JSON reply goes in
 * `structured_output` when the call gives `--json-schema`. Its session goes where Claude Code keeps it, under
 * `CLAUDE_CONFIG_DIR` or `~/.claude`, in a project directory cut at 200 characters with Claude Code's hash, unless the
 * call passes `--no-session-persistence`. `--resume <id>` continues that session, under the same id.
 */
export const claudeFake = {
  executable: 'claude',
  version: '2.1.199 (Claude Code)',
  data: {
    answered: recorded('claude-call-answered.json'),
    failed: recorded('claude-call-failed.json'),
    transcript: recorded('claude-code-transcript.jsonl'),
  },
  script: String.raw`
  const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : randomUUID();
  const streams = args.includes('stream-json') || args.includes('--output-format=stream-json');
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'claude-sonnet-4-5';
  if (streams) await say(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd: process.cwd() }));
  if (does('hang')) return hang();
  if (does('fail')) {
    await say(JSON.stringify({ ...JSON.parse(data.failed), session_id: sessionId }));
    process.exit(1);
  }
  const result = { ...JSON.parse(data.answered), session_id: sessionId };
  if (reply !== undefined) result.result = reply;
  if (args.includes('--json-schema')) { try { result.structured_output = JSON.parse(result.result); } catch {} }
  if (streams) await say(JSON.stringify({ type: 'assistant', session_id: sessionId, message: { model, content: [{ type: 'text', text: result.result }] } }));
  if (!args.includes('--no-session-persistence')) {
    const cwd = fs.realpathSync(process.cwd());
    const dir = (${String(claudeProjectDirName)})(cwd);
    const project = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude'), 'projects', dir);
    const fill = (text) => text.replaceAll('{{cwd}}', cwd).replaceAll('{{sessionId}}', sessionId);
    fs.mkdirSync(project, { recursive: true });
    fs.appendFileSync(path.join(project, sessionId + '.jsonl'), fill(data.transcript) + '\n');
    if (does('subagent')) {
      const agents = path.join(project, sessionId, 'subagents');
      fs.mkdirSync(agents, { recursive: true });
      const first = JSON.parse(fill(data.transcript.split('\n')[0]));
      fs.writeFileSync(path.join(agents, 'agent-a1.jsonl'), JSON.stringify({ ...first, isSidechain: true, agentId: 'a1' }) + '\n');
    }
  }
  await say(JSON.stringify(result));
  process.exit(0);
`,
};
