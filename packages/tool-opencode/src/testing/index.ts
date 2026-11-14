import fs from 'node:fs';

const recorded = (name: string): string => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8').trim();

/**
 * How a fake `opencode` answers, for `fakeAgent` of @teamai/tool-testing: the events `opencode run --format json`
 * printed for real, with the reply in its text part and a fresh session id.
 */
export const opencodeFake = {
  executable: 'opencode',
  version: 'opencode v2.0.29',
  data: {
    answered: recorded('opencode-run-answered.jsonl'),
    failed: recorded('opencode-run-failed.jsonl'),
  },
  script: String.raw`
  const sessionId = 'ses_' + randomUUID().replaceAll('-', '').slice(0, 26);
  const events = (does('fail') ? data.failed : data.answered).split('\n').map((line) => JSON.parse(line));
  for (const [index, event] of events.entries()) {
    event.sessionID = sessionId;
    if (event.type === 'text' && reply !== undefined) event.part.text = reply;
    await say(JSON.stringify(event));
    if (index === 0 && does('hang')) return hang();
  }
  process.exit(does('fail') ? 1 : 0);
`,
};

export * from './fake-opencode.js';
