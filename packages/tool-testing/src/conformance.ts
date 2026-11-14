import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_PROCESSES, probeBinary } from '@teamai/shared/exec';
import { readRegularFileSync, writeRegularFile } from '@teamai/shared/regular-file';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readVersion } from '@teamai/tool-core/detect';
import type { ToolFamily } from '@teamai/tool-core/family';
import { ACCESS_LEVELS, ASSUMED_OPENCODE_MAJOR, type CallInput, type LaunchAdapter } from '@teamai/tool-core/launch';
import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import { locatesOwnStore, type SessionHost, type SessionPlatformDefinition } from '@teamai/tool-core/sessions/platform';
import type { TokenUsage } from '@teamai/tool-core/tokens';
import { fakeCli } from './fake-cli.js';
import { replayTranscript, type RecordedTranscript } from './replay-transcript.js';

// A replayed transcript is only read, and only writing a session runs a tool's CLI.
const SESSION_HOST: SessionHost = { processes: HOST_PROCESSES, executablesOf: (tool) => [tool], homeEnvAt: (_tool, dir) => ({ CODEX_HOME: dir }) };

export type { RecordedTranscript, ReplayTarget } from './replay-transcript.js';

/** What a launch profile's tool printed for one call, recorded, and what teamai reads from it. */
export interface RecordedCall {
  readonly answered: { readonly stdout: string; readonly lastMessage?: string; readonly text: string };
  readonly failed: { readonly stdout: string; readonly lastMessage?: string; readonly message?: string };
}

/** A transcript in a token format, recorded, and the usage it holds. */
export interface RecordedUsage {
  readonly text: string;
  readonly tokens: TokenUsage;
  /** For a format that finds the transcript by session id: where the tool keeps it under `store`. */
  place?(store: string, sessionId: string): string;
  /** The environment that points such a format at `store`. */
  env?(store: string): Readonly<Record<string, string>>;
}

/** What a tool printed for `--version`, recorded, and the version teamai reads from it; or why none is recorded. */
export type RecordedVersion = { readonly command: string; readonly stdout: string; readonly version: string } | { readonly unrecorded: string };

/** The recordings a family's conformance run reads, each keyed by the id of the row it exercises. */
export interface FamilyRecordings {
  /** By launch profile id: one for every profile a tool of the family names. */
  readonly calls: Readonly<Record<string, RecordedCall>>;
  /** By session platform id: one for every platform of the family, or why none can be recorded. */
  readonly transcripts: Readonly<Record<string, RecordedTranscript | { readonly unrecorded: string }>>;
  /** By token format id: one for every format a tool of the family names, or why none can be recorded. */
  readonly tokens: Readonly<Record<string, RecordedUsage | { readonly unrecorded: string }>>;
  /** By the tool or platform id a detector is keyed by: one for every detector of the family. */
  readonly versions: Readonly<Record<string, RecordedVersion>>;
}

/** The text of a recording beside a family's test, such as `new URL('./fixtures/x.json', import.meta.url)`. */
export function fixtureText(url: URL): string {
  return readRegularFileSync(fileURLToPath(url), 'utf8');
}

const PROMPT = 'Reply with the name of the test runner.';
const SESSION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const sessionIdOf = (transcript: RecordedTranscript): string => transcript.sessionId ?? SESSION_ID;

function recorded<T>(table: Readonly<Record<string, T>>, id: string, kind: string): T {
  const found = table[id];

  if (found === undefined) throw new Error(`No recorded ${kind} for "${id}": add one to the family's conformance test.`);

  return found;
}

function scratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `teamai-conformance-${label}-`));
}

function describeLaunch(id: string, profile: LaunchAdapter, call: RecordedCall): void {
  describe(`launch profile ${id}`, () => {
    const input: CallInput = { prompt: PROMPT, promptFile: '/scratch/prompt.md', lastMessageFile: '/scratch/last-message.txt', opencodeMajor: ASSUMED_OPENCODE_MAJOR };
    const args = profile.call.args(input);

    it(`hands the prompt over on ${profile.call.prompt}`, () => {
      switch (profile.call.prompt) {
        case 'stdin':
          expect(profile.call.stdinOf?.(PROMPT) ?? PROMPT).toContain(PROMPT);
          expect(args).not.toContain(PROMPT);
          break;
        case 'argv':
          expect(args).toContain(PROMPT);
          break;
        case 'file':
          expect(args).toContain(input.promptFile);
          expect(args).not.toContain(PROMPT);
          break;
        default: {
          const unhandled: never = profile.call.prompt;

          throw new Error(`Unknown prompt transport: ${String(unhandled)}`);
        }
      }
    });

    it('reads a recorded answer', () => {
      const { stdout, lastMessage, text } = call.answered;

      expect(profile.call.read({ stdout, lastMessage })).toMatchObject({ ok: true, text });
    });

    it('reads a recorded failure as a failure', () => {
      const { stdout, lastMessage, message } = call.failed;
      const reading = profile.call.read({ stdout, lastMessage });

      expect(reading.ok).toBe(false);

      if (message !== undefined) expect(reading).toEqual({ ok: false, message });
    });

    if (profile.step) {
      const { unattended } = profile.step;

      it('runs unattended steps with arguments, or launches none', () => {
        if (unattended !== 'none') expect(unattended.args.length).toBeGreaterThan(0);
      });
    }

    if (profile.confined) {
      const { access } = profile.confined;

      it('declares what its confined run can do', () => {
        expect(ACCESS_LEVELS).toContain(access);
      });
    }
  });
}

/**
 * The adapter on a fresh store, outside any tool home, with the recorded transcript replayed into it under `cwd`, and the
 * environment the recording names for it.
 */
function replayed(platform: SessionPlatformDefinition, transcript: RecordedTranscript, cwd: string) {
  const store = scratch('store');

  replayTranscript(transcript, { store, cwd, sessionId: sessionIdOf(transcript) });

  for (const [variable, value] of Object.entries(transcript.env?.(store) ?? {})) vi.stubEnv(variable, value);

  if (!locatesOwnStore(platform)) return { store, adapter: platform.adapter(store, SESSION_HOST) };

  if (transcript.env === undefined) throw new Error('A platform that locates its own store needs a recording whose env points it at the replayed store.');
  const adapter: AgentAdapter = platform.adapter();

  return { store, adapter };
}

function describePlatform(id: string, platform: SessionPlatformDefinition, transcript: RecordedTranscript): void {
  describe(`session platform ${id}`, () => {
    const sessionId = sessionIdOf(transcript);
    const made: string[] = [];

    const dir = (label: string): string => {
      const created = scratch(label);

      made.push(created);

      return created;
    };

    afterEach(() => {
      vi.unstubAllEnvs();

      for (const created of made.splice(0)) fs.rmSync(created, { recursive: true, force: true });
    });

    it('finds a replayed transcript by its workspace and reads it by id', async () => {
      const cwd = dir('cwd');
      const { store, adapter } = replayed(platform, transcript, cwd);

      made.push(store);
      expect(adapter.platform).toBe(id);
      expect((await adapter.listConversations(cwd)).map((meta) => meta.sessionId)).toContain(sessionId);
      expect(await adapter.existingSessionId(sessionId, cwd)).toBe(sessionId);
      const session = await adapter.readSession({ sessionId, projectPath: cwd });

      expect(session.platform).toBe(id);
      expect(session.messages.flatMap((message) => message.content).flatMap((block) => (block.type === 'text' ? [block.text] : []))).toContain(transcript.userText);
    });

    if (platform.readOnly) return;

    it('writes a session into another workspace, reads it back and deletes it', async () => {
      const cwd = dir('cwd');
      const target = dir('target');
      const { store, adapter } = replayed(platform, transcript, cwd);

      made.push(store);
      const session = await adapter.readSession({ sessionId, projectPath: cwd });
      const written = await adapter.writeSession(session, target);

      expect(written).not.toBe(sessionId);
      const back = await adapter.readSession({ sessionId: written, projectPath: target });

      expect(back.messages.length).toBe(session.messages.length);
      expect(await adapter.deleteSession(written, target)).toBe(true);
      expect(await adapter.existingSessionId(written, target)).toBeUndefined();
    });
  });
}

/**
 * The suite every family runs for each of its tools: only the rows a tool names, each against a recording. A launch
 * profile hands the prompt over by its transport and reads a recorded answer and a recorded failure; a session platform
 * finds and reads a replayed transcript on a store outside any tool home, and, unless it is read-only, writes, reads
 * back and deletes a copy; a token format reads the recorded usage. A row a tool names that the family lacks, or one
 * with no recording, fails.
 */
export function describeFamily(name: string, family: ToolFamily, recordings: FamilyRecordings): void {
  describe(`${name} conformance`, () => {
    for (const [tool, descriptor] of Object.entries(family.tools)) {
      describe(tool, () => {
        it('names only rows its family declares', () => {
          if (descriptor.launch !== 'none') expect(Object.keys(family.launch)).toContain(descriptor.launch);

          if (descriptor.sessions instanceof Object) for (const platform of descriptor.sessions) expect(Object.keys(family.platforms)).toContain(platform);

          if (!['copilot-shutdown', 'none', 'unknown'].includes(descriptor.tokens)) expect(Object.keys(family.tokens)).toContain(descriptor.tokens);
        });
      });
    }

    for (const [id, profile] of Object.entries(family.launch)) describeLaunch(id, profile, recorded(recordings.calls, id, 'call'));

    for (const [id, platform] of Object.entries(family.platforms)) {
      const transcript = recorded(recordings.transcripts, id, 'transcript');

      if ('unrecorded' in transcript) it.skip(`session platform ${id} reads a replayed transcript: ${transcript.unrecorded}`, () => undefined);
      else describePlatform(id, platform, transcript);
    }

    // A version recorded with no detector to read it means teamai records that tool with no version.
    for (const id of Object.keys(recordings.versions)) {
      it(`has a detector for the recorded version of ${id}`, () => {
        expect(Object.keys(family.detect)).toContain(id);
      });
    }

    for (const [id, detector] of Object.entries(family.detect)) {
      const recording = recorded(recordings.versions, id, 'version');

      it(`detects the version of ${id} only for a tool or platform of the family`, () => {
        expect([...Object.keys(family.tools), ...Object.keys(family.platforms)]).toContain(id);
      });

      if ('unrecorded' in recording) {
        it.skip(`reads the version of ${id}: ${recording.unrecorded}`, () => undefined);
        continue;
      }

      it(`reads the version of ${id} from a recorded --version`, async () => {
        const dir = fakeCli(recording.command, { stdout: recording.stdout });

        vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH ?? ''}`);

        try {
          expect(await readVersion(detector, probeBinary)).toBe(recording.version);
        } finally {
          vi.unstubAllEnvs();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    for (const [id, format] of Object.entries(family.tokens)) {
      const usage = recorded(recordings.tokens, id, 'usage');

      if ('unrecorded' in usage) {
        it.skip(`token format ${id} reads the recorded usage: ${usage.unrecorded}`, () => undefined);
        continue;
      }

      it(`token format ${id} reads the recorded usage`, async () => {
        const dir = scratch('tokens');

        try {
          const transcriptPath = usage.place?.(dir, SESSION_ID) ?? path.join(dir, `${SESSION_ID}.jsonl`);

          fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
          await writeRegularFile(transcriptPath, usage.text);

          for (const [variable, value] of Object.entries(usage.env?.(dir) ?? {})) vi.stubEnv(variable, value);

          expect((await format({ transcriptPath, sessionId: SESSION_ID, settled: true, storeDir: dir }, HOST_PROCESSES)).tokens).toEqual(usage.tokens);
        } finally {
          vi.unstubAllEnvs();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
}
