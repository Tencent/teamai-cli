import path from 'node:path';
import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

/** Codex keeps a session at `<store>/YYYY/MM/DD/rollout-<started at>-<id>.jsonl`, under the day it started. */
const codexTranscript = {
  text: fixture('codex-rollout.jsonl'),
  place: (store: string, _cwd: string, sessionId: string): string => path.join(store, '2026', '10', '30', `rollout-2026-10-30T09-15-02-${sessionId}.jsonl`),
  userText: 'Which test runner does this repo use?',
};

describeFamily('tool-codex', family, {
  calls: {
    codex: {
      answered: { stdout: fixture('codex-exec-answered.jsonl'), lastMessage: 'It uses Vitest.\n', text: 'It uses Vitest.' },
      failed: {
        stdout: fixture('codex-exec-failed.jsonl'),
        message: "The 'gpt-nonexistent' model is not supported when using Codex with a ChatGPT account.",
      },
    },
  },
  transcripts: { codex: codexTranscript, 'codex-internal': codexTranscript, tcodex: codexTranscript },
  // Codex counts cached tokens inside input_tokens: 12000 in, 9000 of them cached.
  tokens: {
    'codex-rollout': { text: fixture('codex-rollout.jsonl'), tokens: { input: 3000, output: 180, cacheRead: 9000, cacheCreation: 0 } },
  },
  // codex-cli 0.167.0, 2026-11-11.
  versions: {},
});
