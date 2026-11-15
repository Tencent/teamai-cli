import path from 'node:path';
import { encodeCwdGeneric } from '@teamai/tool-core/sessions/fs';
import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

/** The Cursor agent keeps a session at `<store>/<encoded cwd>/agent-transcripts/<id>/<id>.jsonl`. */
const cursorTranscript = {
  text: fixture('cursor-agent-transcript.jsonl'),
  place: (store: string, cwd: string, sessionId: string): string => path.join(store, encodeCwdGeneric(cwd), 'agent-transcripts', sessionId, `${sessionId}.jsonl`),
  userText: 'Which test runner does this repo use?',
};

describeFamily('tool-cursor', family, {
  calls: {
    cursor: {
      answered: { stdout: fixture('cursor-agent-answered.json'), text: 'It uses Vitest.' },
      failed: { stdout: fixture('cursor-agent-failed.json'), message: 'Authentication required. Run `cursor-agent login` or set CURSOR_API_KEY.' },
    },
  },
  transcripts: { cursor: cursorTranscript },
  tokens: {},
  versions: { cursor: { command: 'cursor', stdout: '1.7.38\n0e8b5a2f1c7d4e6b9a3f2c1d0e9b8a7f6c5d4e3b\narm64', version: '1.7.38' } },
});
