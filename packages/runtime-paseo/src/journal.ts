import fs from 'node:fs';
import path from 'node:path';
import { hold } from '@teamai/runtime-kit/journal';
import { ConfinedKeptSchema, OpIdSchema, OpStateSchema, RUN_DIR_ENV, WORKFLOW_DIR_ENV, type OpId } from '@teamai/runtime-protocol';
import { z } from 'zod';
import { readRegularFileSync } from '@teamai/shared/regular-file';

// ─── The journal ─────────────────────────────────────────
//
//  What this runtime keeps across its own restarts, in a directory on the host:
//
//    places/<handle>.json   the attempt a handle opened, and the Paseo workspace that adopted its worktree once Paseo
//                           opened it, or, for a confined prompt's place, the prompt's directory
//    ops/<op>.json          a prompt: its handle, then the agent create it sends, whether it sent it and Paseo showed
//                           the agent, or the agent it sends a turn to, and once it ended, its outcome
//    ops/<op>.cancel        teamai cancelled it, written before the agent is cancelled: Paseo reports a cancelled
//                           agent as idle, so only this file tells a cancel from a finish
//    conversations/<op>.json  a conversation a workflow prompt started, by its id, that prompt's op: the place that owns
//                           it, whose close ends it, and the agent it runs on. A later prompt that continues it, in
//                           a place of its own, finds it here and sends its turn to that agent
//    handles/<handle>/<op>  the prompts of a handle, written before each prompt's record, so a handle reads only its
//                           own records, and one that cannot be read stops only its own handle
//    opening/<directory>    the pid of the runtime opening a Paseo workspace on a directory: one open at a time decides
//                           whether the workspace there is the member's, so none takes teamai's own for theirs
//
//  The agent create is kept as sent, so a runtime started again sends the same one: Paseo answers a repeated
//  idempotency key with the agent it created, and refuses one whose request changed. Each file is written to a
//  temporary path and renamed into place. `close` removes a handle's files.
//

const WorkspaceSchema = z.object({ id: z.string(), name: z.string() });

/**
 * An attempt's place: a worktree a Paseo workspace adopted, or a confined prompt's, opened with no view of the host,
 * whose workspace adopts the prompt's directory once the prompt comes.
 */
const PlaceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('worktree'),
    run: z.string(),
    attempt: z.string(),
    /** Absent until Paseo opened the worktree: the open is accepted, and its handle kept, before. */
    workspace: WorkspaceSchema.optional(),
    /**
     * Whether the workspace on the worktree is the member's, as Paseo had it open before teamai opened it, so teamai
     * never archives it. Decided before Paseo is asked to open it, so an open repeated after a restart, which finds the
     * workspace its first try made, decides the same.
     */
    member: z.boolean().optional(),
    /** The worktree: as teamai gave it until Paseo opened it, then as the workspace adopted it. */
    cwd: z.string(),
    /** The run's scratch directory, which the place's agents write at its own path. */
    runDir: z.string(),
    /**
     * For a place teamai runs through a sandbox (`through: sandbox`): the outer runtime's handle, which names the attempt
     * socket each agent here registers on, the Paseo provider that runs the tool as teamai's wrapper, and the attempt's
     * tool home, which keeps its sessions.
     */
    through: z.object({ outer: z.string(), provider: z.string(), home: z.string().optional() }).optional(),
  }),
  z.object({ kind: z.literal('confined'), run: z.string(), attempt: z.string(), workspace: WorkspaceSchema.optional() }),
]);

export type Place = z.infer<typeof PlaceSchema>;

/** The environment this runtime gives an agent: the run directory's and the workflow folder's paths and nothing else, since Paseo keeps it in plain text. */
const AgentEnvSchema = z.strictObject({ [RUN_DIR_ENV]: z.string(), [WORKFLOW_DIR_ENV]: z.string().optional() });

/** The agent create a prompt sends, every field of it decided before it is first sent. */
const AgentCreateSchema = z.object({
  agentId: z.uuid(),
  idempotencyKey: z.string(),
  title: z.string(),
  prompt: z.string(),
  labels: z.record(z.string(), z.string()),
  /** `AgentEnv`, and any key a later runtime on this journal sends, kept as it wrote it, so a create sent again is the same. */
  env: AgentEnvSchema.catchall(z.string()).optional(),
  config: z.object({
    provider: z.string(),
    /** Absent: the mode Paseo starts the tool in when it sets no default for it. */
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    /**
     * The provider's own launch options: for Claude, the tools it may use without asking; for Codex, the directories its
     * sandbox writes besides the worktree, or, for a confined prompt, a sandbox that writes nothing; for OpenCode, the
     * directories outside its project it may touch without asking.
     */
    options: z.union([
      z.strictObject({ allowedTools: z.array(z.string()) }),
      z.strictObject({ sandbox_workspace_write: z.strictObject({ writable_roots: z.array(z.string()) }) }),
      z.strictObject({ permission: z.strictObject({ external_directory: z.record(z.string(), z.literal('allow')) }) }),
      z.strictObject({ sandbox_mode: z.literal('read-only') }),
    ]).optional(),
  }),
});

/** The agent create this runtime builds, whose env holds only `AgentEnv`; one read back may hold a later runtime's keys too. */
export type AgentCreate = Omit<z.infer<typeof AgentCreateSchema>, 'env'> & { env?: z.infer<typeof AgentEnvSchema> };

/**
 * A prompt: refused before it was accepted (its tool is not offered), accepted before Paseo was asked anything, or run
 * by an agent, with how it ended once it did. A pending prompt never sent a create: its agent record is journaled before
 * the create is sent, so a cancel that finds it pending ends it with no agent to stop.
 */
const PromptRecordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('refused'), handle: z.string(), outcome: OpStateSchema }),
  z.object({ kind: z.literal('pending'), handle: z.string(), outcome: OpStateSchema.optional() }),
  z.object({
    kind: z.literal('agent'),
    handle: z.string(),
    tool: z.string(),
    /**
     * Where the answer comes from: the workflow result file the agent writes, or, for a confined prompt, its last
     * message, reported with the level and access the runtime kept.
     */
    answer: z.discriminatedUnion('kind', [
      /** `interactive`: a person works through the step with the agent, which idles between their turns until it writes the file. */
      z.object({ kind: z.literal('result-file'), file: z.string(), interactive: z.literal(true).optional() }),
      z.object({ kind: z.literal('reply'), kept: ConfinedKeptSchema }),
    ]),
    /** The directory the agent works in: the worktree, or a confined prompt's directory. */
    cwd: z.string(),
    create: AgentCreateSchema,
    /**
     * Whether a create was sent: absent until one is about to be, which proves none was; `unconfirmed` once one may have
     * reached Paseo, which may still start its agent though the create failed; `confirmed` once Paseo showed the agent.
     */
    dispatched: z.enum(['unconfirmed', 'confirmed']).optional(),
    /**
     * Through a sandbox, the agent is created with no prompt, and gets it once its wrapper connected; a prompt that
     * continues an earlier one's agent gets it as a new turn. Set before the prompt is sent, so a runtime started again
     * never sends it twice.
     */
    sent: z.literal(true).optional(),
    /**
     * For a prompt sent as a new turn of an agent it did not create: the turn, and whose agent that is, the earlier prompt
     * whose conversation it continues, or the session Paseo imported for it, which the lease resumes. `create` is that
     * agent's: the earlier prompt's create, which stays that prompt's, or the one the import stands for. `sentAt`: when the
     * turn was journaled sent, just before the send, from which on the session's requests are the turn's; absent until
     * then, and from a record kept before it was, whose turn reports no tokens.
     */
    turn: z.object({ prompt: z.string(), of: z.union([z.strictObject({ op: OpIdSchema }), z.strictObject({ session: z.string() })]), sentAt: z.number().optional() }).optional(),
    outcome: OpStateSchema.optional(),
  }),
]);

export type PromptRecord = z.infer<typeof PromptRecordSchema>;

export type AgentPrompt = Extract<PromptRecord, { kind: 'agent' }>;

/** A conversation: the place that owns it, the tool it runs, and the create of the agent it runs on, with that agent's id. */
const ConversationSchema = z.object({ handle: z.string(), tool: z.string(), create: AgentCreateSchema });

export type Conversation = z.infer<typeof ConversationSchema>;

/** A record, or undefined when there is none. A record that cannot be read or parsed is an error, never taken as absent. */
function read<T>(file: string, schema: z.ZodType<T>): T | undefined {
  let text: string;

  try {
    text = readRegularFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }

  return schema.parse(JSON.parse(text));
}

/**
 * A directory as Paseo compares it to find its workspace: resolved and normalised, never through its links, so a
 * checkout opened under another path is another workspace. Paseo folds case for a Windows path.
 */
export function paseoKeyOf(directory: string): string {
  const resolved = path.resolve(directory);

  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * A directory with its links resolved, or as given when it is gone: one directory however it is reached, which Paseo
 * may still open as two workspaces (`paseoKeyOf`).
 */
export function resolvedDir(directory: string): string {
  try {
    return fs.realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
}

function write(file: string, value: Place | PromptRecord | Conversation): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function journal(root: string) {
  const placeFile = (handle: string): string => path.join(root, 'places', `${encodeURIComponent(handle)}.json`);
  const promptFile = (op: OpId): string => path.join(root, 'ops', `${op}.json`);
  const cancelFile = (op: OpId): string => path.join(root, 'ops', `${op}.cancel`);
  const conversationFile = (id: OpId): string => path.join(root, 'conversations', `${id}.json`);
  const names = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

  const indexDir = (handle: string): string => path.join(root, 'handles', encodeURIComponent(handle));

  /** Every place, or, for one whose record cannot be read, its handle alone: what it holds is unknown, not absent. */
  const places = (): Array<{ handle: string; place?: Place }> => names(path.join(root, 'places')).flatMap((name) => {
    const handle = decodeURIComponent(name.replace(/\.json$/, ''));

    try {
      const place = read(placeFile(handle), PlaceSchema);

      return place ? [{ handle, place }] : [];
    } catch {
      return [{ handle }];
    }
  });

  /** The prompts `handle`'s index names; a record outside it is never read for `handle`. */
  const promptsOf = (handle: string): Array<{ op: OpId; record: PromptRecord }> => names(indexDir(handle)).flatMap((name) => {
    const op = OpIdSchema.safeParse(name);
    const record = op.success ? read(promptFile(op.data), PromptRecordSchema) : undefined;

    return op.success && record?.handle === handle ? [{ op: op.data, record }] : [];
  });

  return {
    /** The directory the journal is kept in, for a person to fix when it cannot be written. */
    root,
    place: (handle: string): Place | undefined => read(placeFile(handle), PlaceSchema),
    savePlace(handle: string, place: Place): void {
      fs.mkdirSync(indexDir(handle), { recursive: true });
      write(placeFile(handle), place);
    },
    /**
     * The handle already opened for an attempt, so a repeated open opens no second place. One whose record cannot be read
     * is the attempt's when its name says so, so the open fails on it rather than write a fresh record over it.
     */
    handleOf: ({ run, attempt }: { run: string; attempt: string }): string | undefined => places()
      .find(({ handle, place }) => (place ? place.run === run && place.attempt === attempt : handle.endsWith(`/${run}/${attempt}`)))?.handle,
    /**
     * The handles open on a Paseo workspace, which the last of them archives when it closes: those Paseo opened it for,
     * and those still being opened on its `directory`, which Paseo will open it for.
     */
    handlesIn: ({ id, directory }: { id: string; directory?: string }): string[] => places().filter(({ place }) => (!place
      // A place that cannot be read may be on this workspace: it counts as sharing it.
      ? true
      : place.workspace
        ? place.workspace.id === id
        : place.kind === 'worktree' && directory !== undefined && paseoKeyOf(place.cwd) === paseoKeyOf(directory))).map(({ handle }) => handle),
    /**
     * Whether the workspace on `directory` is the member's, as another attempt's place there decided it, which the
     * workspace a new open finds open may be teamai's own for: undefined when no place there decided it. A place that
     * reached the directory through another path has another workspace, as Paseo keys them, so it decides nothing here.
     */
    memberOn: (directory: string, except: string): boolean | undefined => places()
      .flatMap(({ handle, place }) => (handle !== except && place?.kind === 'worktree' && paseoKeyOf(place.cwd) === paseoKeyOf(directory)
        ? [place.member] : []))
      .find((member) => member !== undefined),
    /**
     * Holds `directory` for one open at a time across the runtimes on this journal, waiting while another live runtime
     * holds it, and taking it from one that died or has held it too long: its runtime gives up on each question to Paseo
     * after 20 s, well within that. Whichever of two opens journals first whether the workspace is the member's decides it
     * for the other, which reads it before it decides. Resolves to its release, which leaves a hold another open took
     * over; rejects when the hold cannot be written.
     */
    holdOpen: (directory: string): Promise<() => void> => hold(path.join(root, 'opening'), resolvedDir(directory)),
    /**
     * Holds the custom providers of the daemon at `url` for one runtime at a time on this journal, as `holdOpen` holds a
     * directory: two opens that would add the same provider add it once.
     */
    holdProviders: (url: string): Promise<() => void> => hold(path.join(root, 'providers'), url),
    prompt: (op: OpId): PromptRecord | undefined => read(promptFile(op), PromptRecordSchema),
    savePrompt(op: OpId, record: PromptRecord): void {
      // Indexed under the directory `savePlace` made: a handle `forget` removed gets none back.
      if (fs.existsSync(indexDir(record.handle))) fs.writeFileSync(path.join(indexDir(record.handle), op), '');
      write(promptFile(op), record);
    },
    promptsOf,
    cancel(op: OpId): void {
      fs.mkdirSync(path.dirname(cancelFile(op)), { recursive: true });
      fs.writeFileSync(cancelFile(op), '');
    },
    isCancelled: (op: OpId): boolean => fs.existsSync(cancelFile(op)),
    /** The conversation the prompt `id` started, while the place that owns it is open. */
    conversation: (id: OpId): Conversation | undefined => read(conversationFile(id), ConversationSchema),
    /** Keeps a conversation for its place, unless a close already forgot that place. */
    saveConversation(id: OpId, conversation: Conversation): void {
      if (fs.existsSync(indexDir(conversation.handle))) write(conversationFile(id), conversation);
    },
    /** Removes everything kept for `handle`. */
    forget(handle: string): void {
      for (const { op } of promptsOf(handle)) {
        fs.rmSync(promptFile(op), { force: true });
        fs.rmSync(cancelFile(op), { force: true });
      }

      // The conversations the place started end with it, found by the place each names; one that cannot be read is
      // left, since its place is unknown, and no later prompt continues it.
      for (const name of names(path.join(root, 'conversations'))) {
        const file = path.join(root, 'conversations', name);

        let owner: string | undefined;

        try {
          owner = read(file, ConversationSchema)?.handle;
        } catch {
          owner = undefined;
        }

        if (owner === handle) fs.rmSync(file, { force: true });
      }


      fs.rmSync(placeFile(handle), { force: true });
      fs.rmSync(indexDir(handle), { recursive: true, force: true });
    },
  };
}

export type Journal = ReturnType<typeof journal>;
