import path from 'node:path';
import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

describeFamily('tool-muse', family, {
  calls: {
    muse: {
      answered: { stdout: fixture('muse-exec-answered.jsonl'), text: 'It uses Vitest.' },
      failed: { stdout: fixture('muse-exec-failed.jsonl'), message: 'Not signed in: run `muse login`.' },
    },
  },
  transcripts: {
    // Muse keeps a session at `<store>/YYYY/MM/DD/<id>/session.jsonl`, and finds it by its metadata's workspace_root.
    muse: {
      text: fixture('muse-transcript.jsonl'),
      place: (store, _cwd, sessionId) => path.join(store, '2026', '11', '03', sessionId, 'session.jsonl'),
      userText: 'Which test runner does this repo use?',
    },
  },
  // Muse counts cached tokens inside input_tokens, and finds the log by session id under $XDG_DATA_HOME/muse/sessions.
  tokens: {
    'muse-session': {
      text: fixture('muse-session.jsonl'),
      place: (store, sessionId) => path.join(store, 'muse', 'sessions', '2026', '10', '30', sessionId, 'session.jsonl'),
      env: (store) => ({ XDG_DATA_HOME: store }),
      tokens: { input: 2000, output: 600, cacheRead: 10000, cacheCreation: 0 },
    },
  },
  versions: { muse: { command: 'muse', stdout: 'Muse Code 1.4.6 (1.4.6-R6000.1)', version: '1.4.6' } },
});
