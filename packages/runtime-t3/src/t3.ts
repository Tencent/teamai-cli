import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import semver from 'semver';
import { z } from 'zod';
import { ScriptSchema } from './settings.js';

// ─── A T3 Code environment, over its MCP endpoint ───
//
//  The tools this runtime calls, each read back through a schema of the fields it uses. T3 answers a tool call with
//  its result as JSON text (and as structured content on newer servers); a tool error carries T3's own message.
//

export const EnvironmentSchema = z.object({ environmentId: z.string().min(1), label: z.string(), serverVersion: z.string().optional() });

export type Environment = z.infer<typeof EnvironmentSchema>;

/** The oldest T3 Code this runtime runs against: the version it is tested against, whose nightlies count as it. */
export const OLDEST_T3 = '0.1.8';

/** Why this runtime does not run against the T3 Code of `environment`, when it is older than `OLDEST_T3` or says no version. */
export function tooOld({ serverVersion }: Environment): string | undefined {
  const version = serverVersion === undefined ? null : semver.coerce(serverVersion);

  if (version !== null && semver.gte(version, OLDEST_T3)) return undefined;

  return `T3 Code ${serverVersion === undefined ? 'did not say which version it runs' : `runs version ${serverVersion}`}; teamai-runtime-t3 needs T3 Code 0.1.8 or later. Update T3 Code, then start the workflow again.`;
}

const ModelSchema = z.object({ id: z.string().min(1), options: z.array(z.object({ id: z.string(), values: z.array(z.unknown()) })).optional() });

const ProviderSchema = z.object({
  providerInstanceId: z.string().min(1),
  driverKind: z.string().min(1),
  displayName: z.string(),
  models: z.array(ModelSchema),
  /** Why T3 cannot run this instance now, such as "Provider instance is disabled."; empty when it can. */
  constraints: z.array(z.string()).optional(),
});

export type Provider = z.infer<typeof ProviderSchema>;

/** A project as `t3_project_list` lists it; one T3 deleted keeps its row with `deletedAt` set. Its scripts are read loosely. */
const ProjectSchema = z.object({
  id: z.string().min(1), title: z.string(), workspaceRoot: z.string(), deletedAt: z.string().nullable().optional(),
  scripts: z.array(ScriptSchema).optional().catch(undefined),
  /**
   * The repository T3 found in the project's git remote, as `host/path`. T3 finds none for a remote on this machine's
   * disk.
   */
  repositoryIdentity: z.object({ canonicalKey: z.string() }).nullable().optional().catch(undefined),
  /** The model the member set for the project's new threads. */
  defaultModelSelection: z.object({ instanceId: z.string().min(1), model: z.string().min(1) }).nullable().optional().catch(undefined),
});

export type Project = z.infer<typeof ProjectSchema>;

/** Another machine's T3 Code environment linked to this one, as `t3_environment_links` lists it. */
const EnvironmentLinkSchema = z.object({ environmentId: z.string().min(1), label: z.string(), status: z.string() });

export type EnvironmentLink = z.infer<typeof EnvironmentLinkSchema>;

const ProjectPageSchema = z.object({ projects: z.array(ProjectSchema), nextCursor: z.number().int().nullable().optional() });

/** A thread's run as T3 reports it; `idle` when the thread has none. */
export const THREAD_STATUSES = ['idle', 'preparing', 'queued', 'starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back'] as const;

/** A launch's answer: the thread, and the model T3 started it on, which it chose itself when the launch named none. */
const LaunchedSchema = z.object({ threadId: z.string().min(1), modelSelection: z.object({ model: z.string() }).optional().catch(undefined) });

/**
 * A wait until the thread's latest run and the work it delegated settled. `status` is that run's own, so it may have
 * ended while `timedOut` says the delegated work has not. Once it has, `resultRun` is the run that answered, such as a
 * later one a delegated task's delivery started. A thread with no run answers `idle`, not timed out.
 */
const WaitedSchema = z.object({
  threadId: z.string(),
  status: z.enum(THREAD_STATUSES),
  timedOut: z.boolean(),
  resultRun: z.object({ runId: z.string(), status: z.enum(THREAD_STATUSES) }).optional(),
});

export type Waited = z.infer<typeof WaitedSchema>;

/**
 * What the runtime reads of a thread: its latest run's status as T3 names it (none before its first run), its folder,
 * how many runs it had, and the requests it holds for a person. The status stays a string: one this runtime does not
 * know reads as a run still going, rather than failing the read a judge's launch makes.
 */
const ThreadShellSchema = z.object({
  status: z.string().nullable(),
  worktreePath: z.string().nullable(),
  runCount: z.number().int().nonnegative(),
  pendingRequestCount: z.number().int().nonnegative(),
  title: z.string().optional().catch(undefined),
  /** The provider instance and model the thread's runs use. T3 reports no model options here. */
  providerInstanceId: z.string().min(1).nullable().optional().catch(undefined),
  model: z.string().min(1).nullable().optional().catch(undefined),
});

export type ThreadShell = z.infer<typeof ThreadShellSchema>;

/** The statuses of a thread whose run still goes, as `t3_thread_list` filters on them. */
export const ACTIVE_STATUSES = ['preparing', 'queued', 'starting', 'running', 'waiting'] as const;

/** Whether a thread at `status` has a run that still goes. */
export function isActive(status: string | null): boolean {
  return ACTIVE_STATUSES.some((one) => one === status);
}

/**
 * A thread `t3_thread_list` lists: a delegated task's thread names the thread that delegated it. T3 lists threads by
 * when they last changed, `updatedAt`, newest first.
 */
const ListedThreadSchema = z.object({ threadId: z.string(), status: z.string().nullable(), parentThreadId: z.string().nullable().optional(), updatedAt: z.string().optional() });

export type ListedThread = z.infer<typeof ListedThreadSchema>;

const ThreadPageSchema = z.object({ threads: z.array(ListedThreadSchema), nextCursor: z.number().int().nullable().optional() });

/** One timeline item of a thread's messages or activity view, read in pages of text when it is long. */
const ItemSchema = z.object({
  itemId: z.string(), type: z.string(), runId: z.string().nullable().optional(), title: z.string().nullable().optional(),
  text: z.string().nullable(), textTruncated: z.boolean(), nextTextOffset: z.number().int().nullable(),
});

type Item = z.infer<typeof ItemSchema>;

/**
 * The title T3 gives the error item of a run its provider stopped on a spent usage limit ("Provider error" for any
 * other); T3's MCP names neither the failure's class nor its reset time otherwise.
 */
export const USAGE_LIMIT_TITLE = 'Usage limit reached';

const ItemPageSchema = z.object({ items: z.array(ItemSchema), nextPosition: z.number().int().nullable(), hasMore: z.boolean() });

/**
 * The T3 modes a step thread may run in, loosest first. `auto` is T3's Auto mode: the provider's own review approves
 * routine actions and asks the person about the rest (a provider without such a review asks about everything).
 * `approval-required` is Supervised: every command and edit waits for the person. `full-access` asks nothing, and a
 * thread runs in it only when the run's `runtime_mode` says so.
 */
export const STEP_MODES = ['full-access', 'auto', 'auto-accept-edits', 'approval-required'] as const;

export type StepMode = (typeof STEP_MODES)[number];

/** What every thread the runtime launches sets. */
export interface NewThread {
  title: string;
  /** None: T3 starts the thread on the member's default for the project, or their fallback once its usage is spent. */
  modelSelection?: { instanceId: string; model: string; options?: Array<{ id: string; value: string | boolean }> };
  /** Never inherited: set from the runtime's options, whatever the caller's mode or the member's grant would let T3 use. */
  runtimeMode: StepMode;
  /** T3 answers a repeated id with the thread it launched for it, and starts no second run. */
  clientRequestId: string;
}

/**
 * A step's thread in a T3 project, started with its first message: on the attempt's worktree of the project, or on
 * the project's own folder, where T3 runs none of the project's setup scripts.
 */
export interface Launch extends NewThread {
  /** None: an idle thread, which a repeated launch that only looks the thread up asks for. */
  message?: string;
  projectId: string;
  workspace: { type: 'existing_worktree'; worktreePath: string } | { type: 'root' };
  /** A linked environment to launch on, whose project `projectId` is: none, this one. */
  environmentId?: string;
  /** The thread here the launch was made for, which T3 shows the launched thread as delegated from. */
  delegatedFrom?: { environmentId: string; threadId: string; title: string };
}

/** The body T3 answers a refused call with, as its text. */
const RefusalSchema = z.object({ code: z.string(), message: z.string() });

type Refusal = z.infer<typeof RefusalSchema>;

/**
 * The refusals of a repeated launch that prove T3 launched nothing for its clientRequestId: the checks a new launch runs
 * (the project, the worktree, the provider instance, the mode the sign-in allows), which T3 skips for a launch it accepted.
 */
const LAUNCHED_NOTHING: ReadonlySet<string> = new Set(['invalid_request', 'runtime_mode_escalation_denied']);

/** A tool call T3 refused or could not answer, with T3's own message. */
export class T3Error extends Error {
  readonly tool: string;
  /** T3's code and message, when its refusal carried them. */
  readonly refusal: Refusal | undefined;

  constructor(tool: string, message: string, refusal?: Refusal) {
    super(message);
    this.tool = tool;
    this.refusal = refusal;
  }

  /** T3 no longer has the thread, such as one the person deleted: nothing of it runs, and nothing is left to settle. */
  get threadGone(): boolean {
    return this.refusal?.code === 'thread_not_found';
  }

  /** T3 refused a launch with a check a new launch runs, so it launched nothing. Any other failure may follow a launch. */
  get launchedNothing(): boolean {
    return this.refusal !== undefined && LAUNCHED_NOTHING.has(this.refusal.code);
  }

  /** T3 refused a tool that acts on another machine because Linked environments is off in its Labs settings. */
  get linkedEnvironmentsOff(): boolean {
    return this.refusal?.code === 'capability_denied';
  }
}

function refusalIn(text: string): Refusal | undefined {
  try {
    const refusal = RefusalSchema.safeParse(JSON.parse(text));

    return refusal.success ? refusal.data : undefined;
  } catch {
    return undefined;
  }
}

export interface T3 {
  environment(): Promise<Environment>;
  /** The provider instances of this environment, or of the linked environment `environmentId`. */
  providers(environmentId?: string): Promise<Provider[]>;
  /** The projects of this environment, or of the linked environment `environmentId`. */
  projects(environmentId?: string): Promise<Project[]>;
  /** The environments linked to this one; T3 refuses while linked environments are off in its Labs settings. */
  environmentLinks(): Promise<EnvironmentLink[]>;
  launch(launch: Launch): Promise<z.infer<typeof LaunchedSchema>>;
  /** Launches an idle thread in a new, empty scratch folder of T3's own, which `thread` names. */
  launchScratch(thread: NewThread): Promise<z.infer<typeof LaunchedSchema>>;
  /** Starts a run of the thread with `message`; a repeated `clientRequestId` sends nothing more. */
  send(threadId: string, message: string, clientRequestId: string): Promise<void>;
  /** Sets the model the thread's next runs use, on the provider instance it runs on. */
  configure(threadId: string, modelSelection: NonNullable<NewThread['modelSelection']>): Promise<void>;
  thread(threadId: string): Promise<ThreadShell>;
  /** Every thread whose run still goes, in every project, delegated tasks' threads included. */
  activeThreads(): Promise<ListedThread[]>;
  /**
   * Every thread not settled yet that changed at or after `since` (ms since the epoch), in every project, delegated
   * tasks' threads included. T3 lists the newest first, so the listing stops at the first thread that changed before.
   */
  unsettledThreadsSince(since: number): Promise<ListedThread[]>;
  /** The thread's last assistant message, whole, or undefined when it wrote none. */
  lastReply(threadId: string): Promise<string | undefined>;
  /** The error T3 recorded last for the thread's run `runId`, or for any run without one: its title and its whole text. */
  lastError(threadId: string, runId: string | undefined): Promise<{ title: string; text: string } | undefined>;
  /** Waits up to `timeoutMs` for the thread's latest run, and the work it delegated, to settle. */
  wait(threadId: string, timeoutMs: number): Promise<Waited>;
  /**
   * Asks T3 to stop the thread as its Stop button does: its running turn and every task it delegated. T3 answers once
   * it has asked the provider, before the run ends, and says no_active_run from the run's own events alone, so only a
   * wait tells when the delegated work stopped too.
   */
  stop(threadId: string): Promise<void>;
  /** Moves the thread out of the person's active threads, to T3's Settled group, where its link still opens it. */
  settle(threadId: string): Promise<void>;
  close(): Promise<void>;
}

/** What a tool call sends: JSON, as MCP carries it. */
type ToolArguments = Record<string, z.core.util.JSONType>;

const TextContentSchema = z.object({ type: z.literal('text'), text: z.string() });

const ToolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.unknown()).optional(),
});

/** The client of a connected endpoint. A request a wait holds open needs more than the SDK's 60 s default. */
function t3Over(client: Client): T3 {
  const call = async <TSchema extends z.ZodType>(tool: string, args: ToolArguments, schema: TSchema, timeout = 60_000): Promise<z.infer<TSchema>> => {
    const result = ToolResultSchema.parse(await client.callTool({ name: tool, arguments: args }, undefined, { timeout }));

    const texts = (result.content ?? []).flatMap((part) => {
      const text = TextContentSchema.safeParse(part);

      return text.success ? [text.data.text] : [];
    });

    if (result.isError) throw new T3Error(tool, texts.join(' ') || `T3 refused ${tool}.`, refusalIn(texts.join(' ')));
    const body: unknown = result.structuredContent ?? JSON.parse(texts.join(''));
    const parsed = schema.safeParse(body);

    if (!parsed.success) throw new T3Error(tool, `T3 answered ${tool} in a shape this runtime does not read: ${z.prettifyError(parsed.error)}`);

    return parsed.data;
  };

  /**
   * The threads `t3_thread_list` lists in every project, delegated tasks' included, with `filter`, page by page; with
   * `since`, only those that changed at or after it, which T3 lists first. A thread that names no change time counts as
   * changed since.
   */
  const listThreads = async (filter: ToolArguments, since?: number): Promise<ListedThread[]> => {
    const threads: ListedThread[] = [];
    let cursor: number | null | undefined = 0;
    const isOlder = (thread: ListedThread): boolean => since !== undefined && thread.updatedAt !== undefined && Date.parse(thread.updatedAt) < since;

    while (cursor !== null && cursor !== undefined) {
      const page: z.infer<typeof ThreadPageSchema> = await call('t3_thread_list', { allProjects: true, includeSubagents: true, ...filter, cursor, limit: 100 }, ThreadPageSchema);
      threads.push(...page.threads.filter((thread) => !isOlder(thread)));
      cursor = page.threads.some(isOlder) ? null : page.nextCursor;
    }

    return threads;
  };

  /** The last item of the thread's `view` that `matches`, read page by page. */
  const lastItem = async (threadId: string, view: 'messages' | 'activity', matches: (item: Item) => boolean): Promise<Item | undefined> => {
    let found: Item | undefined;
    let afterPosition: number | undefined;

    for (;;) {
      const page = await call('t3_thread_read', { threadId, view, limit: 100, ...(afterPosition !== undefined && { afterPosition }) }, ItemPageSchema);
      found = page.items.findLast(matches) ?? found;

      if (!page.hasMore || page.nextPosition === null) return found;
      afterPosition = page.nextPosition;
    }
  };

  /** The whole text of `item`, which T3 sends in pages when it is long. */
  const wholeText = async (threadId: string, item: Item): Promise<string> => {
    let text = item.text ?? '';

    for (let offset = item.textTruncated ? item.nextTextOffset : null; offset !== null;) {
      const [part] = (await call('t3_thread_read', { threadId, itemId: item.itemId, textOffset: offset, maxCharsPerItem: 50_000 }, ItemPageSchema)).items;

      if (!part) break;
      text += part.text ?? '';
      offset = part.textTruncated ? part.nextTextOffset : null;
    }

    return text;
  };

  return {
    environment: () => call('t3_environment_read', {}, EnvironmentSchema),
    providers: async (environmentId) => (await call('orchestrator_capabilities', { ...(environmentId !== undefined && { environmentId }) }, z.object({ providers: z.array(ProviderSchema) }))).providers,
    environmentLinks: async () => (await call('t3_environment_links', {}, z.object({ links: z.array(EnvironmentLinkSchema) }))).links,
    projects: async (environmentId) => {
      const projects: Project[] = [];
      let cursor: number | null | undefined = 0;

      while (cursor !== null && cursor !== undefined) {
        const page: z.infer<typeof ProjectPageSchema> = await call('t3_project_list', { cursor, limit: 100, ...(environmentId !== undefined && { environmentId }) }, ProjectPageSchema);
        projects.push(...page.projects);
        cursor = page.nextCursor;
      }

      return projects;
    },
    launch: (launch) => call('t3_thread_launch', {
      title: launch.title,
      ...(launch.message !== undefined && { message: launch.message }),
      projectId: launch.projectId,
      workspaceStrategy: launch.workspace,
      ...(launch.modelSelection && { modelSelection: launch.modelSelection }),
      runtimeMode: launch.runtimeMode,
      interactionMode: 'default',
      clientRequestId: launch.clientRequestId,
      ...(launch.environmentId !== undefined && { environmentId: launch.environmentId }),
      ...(launch.delegatedFrom && { delegatedFrom: launch.delegatedFrom }),
    }, LaunchedSchema),
    launchScratch: (thread) => call('t3_thread_launch', {
      title: thread.title,
      scratch: true,
      ...(thread.modelSelection && { modelSelection: thread.modelSelection }),
      runtimeMode: thread.runtimeMode,
      interactionMode: 'default',
      clientRequestId: thread.clientRequestId,
    }, LaunchedSchema),
    send: async (threadId, message, clientRequestId) => { await call('t3_thread_send', { threadId, message, mode: 'auto', clientRequestId }, z.object({}).loose()); },
    configure: async (threadId, modelSelection) => { await call('t3_thread_configure', { threadId, modelSelection }, z.object({}).loose()); },
    thread: async (threadId) => (await call('t3_thread_read', { threadId, limit: 1, maxCharsPerItem: 1 }, z.object({ thread: ThreadShellSchema }))).thread,
    activeThreads: () => listThreads({ statuses: [...ACTIVE_STATUSES] }),
    unsettledThreadsSince: (since) => listThreads({ settled: false }, since),
    lastReply: async (threadId) => {
      const reply = await lastItem(threadId, 'messages', (item) => item.type === 'assistant_message');

      return reply && wholeText(threadId, reply);
    },
    lastError: async (threadId, runId) => {
      const error = await lastItem(threadId, 'activity', (item) => item.type === 'error' && (runId === undefined || item.runId === runId));

      return error && { title: error.title ?? '', text: await wholeText(threadId, error) };
    },
    wait: (threadId, timeoutMs) => call('t3_thread_wait', { threadId, timeoutMs, untilDelegatedWorkSettled: true }, WaitedSchema, timeoutMs + 30_000),
    stop: async (threadId) => { await call('t3_thread_interrupt', { threadId, stop: true, reason: 'teamai cancelled the workflow step' }, z.object({ threadId: z.string() }).loose()); },
    settle: async (threadId) => { await call('t3_thread_organize', { threadId, action: 'settle' }, z.object({}).loose()); },
    close: () => client.close(),
  };
}

/** Connects to the MCP endpoint at `resource`, signing in through `auth` when T3 asks for a credential. */
export async function connectT3(resource: URL, auth: OAuthClientProvider, authorize: () => Promise<string>): Promise<T3> {
  const client = new Client({ name: 'teamai-runtime-t3', version: '1' });
  const transport = new StreamableHTTPClientTransport(resource, { authProvider: auth });

  try {
    await client.connect(transport);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    // The SDK sent the person to T3's sign-in page; the code comes back on the loopback redirect.
    await transport.finishAuth(await authorize());
    const signedIn = new Client({ name: 'teamai-runtime-t3', version: '1' });
    // The person approved once. A grant narrower than the run needs leaves no token for it, and a second page would
    // open where nothing listens for its approval any more, so the connection fails instead.
    const approved: OAuthClientProvider = { ...auth, redirectToAuthorization: () => { throw new UnauthorizedError('T3 Code granted a sign-in narrower than the run needs.'); } };
    await signedIn.connect(new StreamableHTTPClientTransport(resource, { authProvider: approved }));

    return t3Over(signedIn);
  }

  return t3Over(client);
}
