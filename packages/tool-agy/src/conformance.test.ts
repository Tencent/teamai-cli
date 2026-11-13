import path from 'node:path';
import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

describeFamily('tool-agy', family, {
  calls: {
    agy: {
      answered: { stdout: fixture('agy-stream-answered.jsonl'), text: 'It uses Vitest.' },
      failed: { stdout: fixture('agy-stream-failed.jsonl'), message: 'You have reached your quota for gemini-3-pro. Try again later.' },
    },
  },
  transcripts: {
    agy: { unrecorded: 'agy finds a conversation by the workspace in its SQLite summaries database, which a text recording cannot hold; session-adapter.test.ts rebuilds it with sqlite3 beside real agy 1.4.8 transcripts' },
  },
  // A real agy 1.4.8 conversation: two planner steps, no cache reads.
  tokens: {
    'agy-transcript': {
      text: fixture('agy/brain/06073d60-63d2-43f8-a8c2-062189a4ddd2/.system_generated/logs/transcript.jsonl'),
      place: (store, sessionId) => path.join(store, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'),
      tokens: { input: 29224, output: 88, cacheRead: 0, cacheCreation: 0 },
    },
  },
  versions: { agy: { command: 'agy', stdout: '1.4.10', version: '1.4.10' } },
});
