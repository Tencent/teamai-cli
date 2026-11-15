import path from 'node:path';
import { workspaceFolderOf } from './testing/ide-history.js';
import { encodeCwdCodeBuddy } from '@teamai/tool-core/sessions/fs';
import { describeFamily, fixtureText, type ReplayTarget } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));
const userText = 'Which test runner does this repo use?';

/** The CodeBuddy CLI keeps a session at `<store>/<encoded cwd>/<id>.jsonl`. */
const codebuddyTranscript = {
  text: fixture('codebuddy-transcript.jsonl'),
  place: (store: string, cwd: string, sessionId: string): string => path.join(store, encodeCwdCodeBuddy(cwd), `${sessionId}.jsonl`),
  userText,
};

/** WorkBuddy keeps the same transcript, with `<id>.meta.json` beside it holding the real cwd. */
const workbuddyTranscript = {
  files: ({ store, cwd, sessionId }: ReplayTarget) => {
    const base = path.join(store, encodeCwdCodeBuddy(cwd), sessionId);

    return [[`${base}.jsonl`, fixture('workbuddy-transcript.jsonl')], [`${base}.meta.json`, fixture('workbuddy-transcript.meta.json')]] as const;
  },
  userText,
};

/**
 * The CodeBuddy IDE keeps a conversation, by a 32-hex id, under `<data>/<ext>/CodeBuddyIDE/<instance>/history/<md5 of the
 * workspace>/`: the workspace's index.json, then the conversation's index.json and one file per message.
 */
const codebuddyIdeTranscript = {
  sessionId: '7c9e66797425440d944be07fc1f90ae7',
  env: (store: string) => ({ TEAMAI_CODEBUDDY_IDE_DATA: store }),
  files: ({ store, cwd, sessionId }: ReplayTarget) => {
    const workspace = path.join(store, 'ext-a', 'CodeBuddyIDE', 'ext-a', 'history', workspaceFolderOf(cwd));
    const conversation = path.join(workspace, sessionId);

    return [
      [path.join(workspace, 'index.json'), fixture('codebuddy-ide-workspace-index.json')],
      [path.join(conversation, 'index.json'), fixture('codebuddy-ide-conversation-index.json')],
      [path.join(conversation, 'messages', 'm1.json'), fixture('codebuddy-ide-message-m1.json')],
      [path.join(conversation, 'messages', 'm2.json'), fixture('codebuddy-ide-message-m2.json')],
    ] as const;
  },
  userText,
};

describeFamily('tool-codebuddy', family, {
  calls: {
    codebuddy: {
      answered: { stdout: fixture('codebuddy-call-answered.json'), text: 'It uses Vitest.' },
      failed: { stdout: fixture('codebuddy-call-failed.json'), message: 'Authentication failed: run `codebuddy login` or set CODEBUDDY_API_KEY.' },
    },
  },
  transcripts: { codebuddy: codebuddyTranscript, 'codebuddy-ide': codebuddyIdeTranscript, workbuddy: workbuddyTranscript },
  // CodeBuddy counts both cache buckets inside prompt_tokens: 12000 in, 9000 read and 500 written.
  tokens: { codebuddy: { text: fixture('codebuddy-transcript.jsonl'), tokens: { input: 2500, output: 180, cacheRead: 9000, cacheCreation: 500 } } },
  versions: {
    codebuddy: { command: 'codebuddy', stdout: '2.176.0', version: '2.176.0' },
    'codebuddy-ide': { unrecorded: 'read from /Applications/CodeBuddy.app/Contents/Info.plist, a path a test cannot place' },
    workbuddy: { unrecorded: 'read from /Applications/WorkBuddy.app/Contents/Info.plist, a path a test cannot place' },
  },
});
