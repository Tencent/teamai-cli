import path from 'node:path';
import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

describeFamily('tool-copilot', family, {
  // `copilot -p <prompt> -s` prints the reply alone, and nothing when the call fails.
  calls: { copilot: { answered: { stdout: fixture('copilot-answered.txt'), text: 'It uses Vitest.' }, failed: { stdout: fixture('copilot-failed.txt') } } },
  // Copilot CLI 0.0.411 keeps each session's event log at <Copilot home>/session-state/<id>/events.jsonl.
  transcripts: {
    copilot: {
      text: fixture('copilot-events.jsonl'),
      place: (store: string, _cwd: string, sessionId: string): string => path.join(store, sessionId, 'events.jsonl'),
      userText: 'Which test runner does this repo use?',
    },
  },
  tokens: {},
  versions: {},
});
