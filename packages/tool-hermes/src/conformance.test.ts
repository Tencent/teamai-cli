import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

describeFamily('tool-hermes', family, {
  // `hermes -z` prints the reply alone, and nothing when the call fails.
  calls: { hermes: { answered: { stdout: fixture('hermes-answered.txt'), text: 'It uses Vitest.' }, failed: { stdout: fixture('hermes-failed.txt') } } },
  transcripts: {
    hermes: { unrecorded: 'Hermes keeps every session in its SQLite state.db, which a text recording cannot hold; session-adapter.test.ts reads it through a stand-in sqlite3' },
  },
  tokens: {},
  versions: { hermes: { command: 'hermes', stdout: '(2026.8.7)\nProject: /Users/dev/.hermes', version: '2026.8.7' } },
});
