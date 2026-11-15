import path from 'node:path';
import { afterAll } from 'vitest';
import fs from 'node:fs';
import { installFakeOpencode } from './testing/index.js';
import { describeFamily, fixtureText, type ReplayTarget } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

// OpenCode keeps its sessions behind its CLI: a stand-in `opencode` serves the replayed export from the data home.
const fakeOpencode = installFakeOpencode();

afterAll(() => {
  fs.rmSync(fakeOpencode, { recursive: true, force: true });
});

/** The export a real OpenCode 2.0.29 printed for a session, which the stand-in keeps at `<data>/fake-opencode/sessions/<id>.json`. */
const opencodeTranscript = {
  sessionId: 'ses_7c9e66797425aBcDeFgHiJkL',
  env: (store: string) => ({ XDG_DATA_HOME: store, PATH: `${fakeOpencode}${path.delimiter}${process.env.PATH ?? ''}` }),
  files: ({ store, sessionId }: ReplayTarget) => [[path.join(store, 'fake-opencode', 'sessions', `${sessionId}.json`), fixture('opencode-export.json')]] as const,
  userText: "\"Use the read tool to read notes.txt, then use the bash tool to run 'ls'. Then reply with one short sentence describing the attached image.\"",
};

describeFamily('tool-opencode', family, {
  calls: {
    opencode: {
      answered: { stdout: fixture('opencode-run-answered.jsonl'), text: 'It uses Vitest.' },
      failed: { stdout: fixture('opencode-run-failed.jsonl'), message: 'Model not found: opencode/no-such-model' },
    },
  },
  transcripts: { opencode: opencodeTranscript },
  tokens: { 'opencode-db': { unrecorded: "OpenCode keeps usage in its SQLite database, which a text recording cannot hold; token-usage.test.ts builds one with sqlite3" } },
  versions: {},
});
