import fs from 'node:fs';
import path from 'node:path';
import { writeRegularFileSync } from '@teamai/shared/regular-file';

/** Where a recorded session goes: the store, the workspace it belongs to, and its id. */
export interface ReplayTarget {
  readonly store: string;
  readonly cwd: string;
  readonly sessionId: string;
}

/**
 * A session a tool wrote, recorded, with `{{cwd}}` and `{{sessionId}}` where it named its workspace and session. A tool
 * that keeps a session in one file records its text and where the file goes; one that keeps it in several records each
 * file and its text.
 */
export type RecordedTranscript = {
  /** A user message the session holds, which reading it must return. */
  readonly userText: string;
  /** The id the tool gives a session, when it is not a UUID. */
  readonly sessionId?: string;
  /**
   * The environment the platform reads the replayed `store` through: the variable that points a platform which locates
   * its own store there, or a stand-in CLI for one that keeps its sessions behind its CLI.
   */
  env?(store: string): Readonly<Record<string, string>>;
} & (
  | {
    readonly text: string;
    /** The file the tool writes the session to in its store. */
    place(store: string, cwd: string, sessionId: string): string;
  }
  | {
    /** Each file the tool writes the session to, and its text. */
    files(target: ReplayTarget): ReadonlyArray<readonly [file: string, text: string]>;
  }
);

/** Write `transcript` into `target.store` as the tool would for the session `target.sessionId` of `target.cwd`. */
export function replayTranscript(transcript: RecordedTranscript, target: ReplayTarget): void {
  const fill = (text: string): string => text.replaceAll('{{cwd}}', target.cwd).replaceAll('{{sessionId}}', target.sessionId);

  const files = 'files' in transcript
    ? transcript.files(target)
    : [[transcript.place(target.store, target.cwd, target.sessionId), transcript.text] as const];

  for (const [file, text] of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeRegularFileSync(file, fill(text));
  }
}
