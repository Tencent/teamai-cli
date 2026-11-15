import * as crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The CodeBuddy IDE's history as the IDE lays it out, for tests to plant conversations in:
//   <data>/<extId>/CodeBuddyIDE/<instId>/history/<md5 of the workspace>/<conversation>/messages/<message>.json
// The default instance has one level less: <data>/<extId>/CodeBuddyIDE/history.

/** The IDE's data directory in `home`, which `TEAMAI_CODEBUDDY_IDE_DATA` names for the code under test. */
export function ideDataIn(home: string): string {
  return path.join(home, 'CodeBuddyExtension', 'Data');
}

/** The history of a regular instance: `<extId>/CodeBuddyIDE/<instId>/history`. */
export function instanceHistory(home: string): string {
  return path.join(ideDataIn(home), 'ext-a', 'CodeBuddyIDE', 'ext-a', 'history');
}

/** The history of the default instance, one level shorter: `<extId>/CodeBuddyIDE/history`. */
export function defaultInstanceHistory(home: string): string {
  return path.join(ideDataIn(home), 'ext-b', 'CodeBuddyIDE', 'history');
}

/** The md5 hex of `text`. */
export function md5(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

/** The folder the IDE keeps workspace `cwd` in: the md5 of its real path, as VS Code hands the IDE a resolved one. */
export function workspaceFolderOf(cwd: string): string {
  return md5(fs.realpathSync(cwd));
}

export interface FixtureConv {
  id: string;
  name?: string;
  messages: Array<{ id: string; role: string; content: unknown[] }>;
}

function writeMessage(messageDir: string, id: string, role: string, content: unknown[], createdAt: string): void {
  fs.mkdirSync(messageDir, { recursive: true });
  fs.writeFileSync(
    path.join(messageDir, `${id}.json`),
    JSON.stringify({ role, message: JSON.stringify({ role, content }), id, extra: JSON.stringify({ modelName: 'custom-local:test-model' }), createdAt }, null, 2),
  );
}

/**
 * Plants workspace `cwd` under `historyRoot`, its folder named by the md5 of `cwd` as given, with conversations `convs`.
 * Each conversation's index lists its messages in the order given, whatever the order of their file names.
 */
export function buildWorkspace(historyRoot: string, cwd: string, convs: FixtureConv[]): string {
  const workspaceDir = path.join(historyRoot, md5(cwd));
  fs.mkdirSync(workspaceDir, { recursive: true });

  const index = {
    conversations: convs.map((conv) => ({
      id: conv.id, type: 'craft', name: conv.name ?? '', createdAt: '2026-09-01T10:00:00.000Z', lastMessageAt: '2026-09-01T11:00:00.000Z',
    })),
    current: convs[0]?.id,
  };

  fs.writeFileSync(path.join(workspaceDir, 'index.json'), JSON.stringify(index, null, 2));

  for (const conv of convs) {
    const convDir = path.join(workspaceDir, conv.id);
    const messageDir = path.join(convDir, 'messages');
    fs.mkdirSync(messageDir, { recursive: true });
    fs.writeFileSync(path.join(convDir, 'index.json'), JSON.stringify({ messages: conv.messages.map((message) => ({ id: message.id, role: message.role, isComplete: true })), requests: [] }, null, 2));
    conv.messages.forEach((message, i) => {
      writeMessage(messageDir, message.id, message.role, message.content, new Date(Date.UTC(2026, 8, 1, 10, i)).toISOString());
    });
  }

  return workspaceDir;
}
