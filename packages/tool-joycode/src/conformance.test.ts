import path from 'node:path';
import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

/** JoyCode keeps a Codex rollout at `<store>/YYYY/MM/DD/rollout-<started at>-<id>.jsonl`, under the day it started. */
const joycodeTranscript = {
  text: fixture('joycode-rollout.jsonl'),
  place: (store: string, _cwd: string, sessionId: string): string => path.join(store, '2026', '10', '30', `rollout-2026-10-30T09-15-02-${sessionId}.jsonl`),
  userText: 'Which test runner does this repo use?',
};

describeFamily('tool-joycode', family, {
  calls: {},
  transcripts: { joycode: joycodeTranscript },
  // Codex-shaped counters: cached tokens are inside input_tokens, 12000 in, 9000 of them cached.
  tokens: {
    'codex-rollout': { text: fixture('joycode-rollout.jsonl'), tokens: { input: 3000, output: 180, cacheRead: 9000, cacheCreation: 0 } },
  },
  versions: {},
});
