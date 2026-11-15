import fs from 'node:fs';
import path from 'node:path';
import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

/** Qoder keeps a Claude Code-shaped session at `<store>/<real cwd with every non-alphanumeric character as ->/<id>.jsonl`;
 * written out here rather than through the adapter's encoder, so an encoder bug fails the round trip. Long cwds are
 * covered with names Claude Code wrote, in tool-claude's sessions.test.ts. */
const qoderTranscript = {
  text: fixture('qoder-transcript.jsonl'),
  place: (store: string, cwd: string, sessionId: string): string => path.join(store, fs.realpathSync(cwd).replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`),
  userText: 'Which test runner does this repo use?',
};

describeFamily('tool-qoder', family, {
  // `qodercli -p` prints the reply alone, and nothing when the call fails.
  calls: { qoder: { answered: { stdout: fixture('qoder-print-answered.txt'), text: 'It uses Vitest.' }, failed: { stdout: fixture('qoder-print-failed.txt') } } },
  transcripts: { qoder: qoderTranscript, 'qoder-cn': qoderTranscript },
  tokens: {
    'claude-jsonl': { text: fixture('qoder-transcript.jsonl'), tokens: { input: 2500, output: 65, cacheRead: 17200, cacheCreation: 300 } },
  },
  versions: {},
});
