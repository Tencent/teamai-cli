import type { ConfinedPrompt, RuntimeRequest } from '@teamai/runtime-protocol';
import type { Daemon } from './daemon/connect.js';
import type { Conversations } from './conversation.js';
import { CONFINED_KEPT, notOffered } from './offer.js';
import type { ProcessState } from './process-state.js';
import { CONFINED_MODES, CONFINED_OPTIONS, isPaseoTool, type PaseoTool } from './providers.js';
import type { ConfinedPlace, workspaces } from './workspace.js';

// ─── A confined prompt, as a judge ───────────────────────
//
//  A fresh agent whose cwd is the prompt's directory, briefed to read only it, in a mode that asks before it edits or
//  runs anything; any request for permission ends it. Its answer is its last message, kept best-effort.
//

/** The prompt a confined prompt's agent gets: the brief that confines it, the step's prompt, and the shape of its answer. */
function confinedBrief(tool: PaseoTool, confined: ConfinedPrompt, prompt: string): string {
  const reply = confined.schema === undefined
    ? 'Reply with only the JSON answer, and no other text.'
    : `Reply with only the JSON answer that matches this JSON Schema, and no other text: ${JSON.stringify(confined.schema)}. Where the prompt above names another schema, this one decides the shape of your reply.`;

  return `Answer from the files in ${confined.dir} alone. ${CONFINED_READING[tool]}: asking for a permission ends this run.\n\n${prompt}\n\n${reply}`;
}

/** How a confined prompt's agent reads its directory. Codex has no file tools: it reads with shell commands, which its read-only sandbox runs without asking. */
const CONFINED_READING: Readonly<Record<PaseoTool, string>> = {
  claude: 'List and read them with your file tools, such as Glob, Grep and Read. Change no file and run no shell command',
  codex: 'List and read them with read-only shell commands, such as ls, cat and rg, which your sandbox runs without asking. Change no file and use no other tool',
  opencode: 'List and read them with your file tools, such as Glob, Grep and Read. Change no file and run no shell command',
};

/** Runs the confined prompts of this process. */
export function judging(state: ProcessState, { conversation, adopt }: { conversation: Conversations; adopt: ReturnType<typeof workspaces>['adopt'] }) {
  const { offers, targets, startedFrom } = state;
  const { refuse, begin, goesOn, settle, launch } = conversation;

  /** A confined prompt: a fresh agent whose cwd is its directory, briefed to read only it, that answers in its last message. */
  async function judge(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>, confined: ConfinedPrompt, place: ConfinedPlace): Promise<void> {
    const { op, lease } = request;

    if (confined.level !== CONFINED_KEPT.level) {
      refuse(op, request.handle, {
        code: 'confined_level',
        message: `teamai-runtime-paseo keeps a confined prompt best-effort: its agent is briefed to read only ${confined.dir}, and nothing stops it reading elsewhere. It does not run one at ${confined.level}.`,
      });

      return;
    }

    const { tool } = lease;

    if (!isPaseoTool(tool) && !offers.has(tool)) {
      refuse(op, request.handle, { code: 'tool_unavailable', message: `teamai-runtime-paseo runs a confined prompt on claude, codex, opencode or the team's instances of them, not ${tool}.` });

      return;
    }

    const unoffered = notOffered(offers, tool, true);
    const target = targets.get(tool);

    if (unoffered || !target) {
      refuse(op, request.handle, unoffered ?? { code: 'tool_unavailable', message: `teamai-runtime-paseo did not offer ${tool}.` });

      return;
    }

    const following = begin(op, request.handle);

    try {
      let workspace = place.workspace && { ...place.workspace, directory: confined.dir };

      if (!workspace) {
        const adopted = await Promise.race([adopt(live, request.handle, place, confined.dir), following.stopped]);

        if (!goesOn(op, following) || adopted === 'stopped') return;

        if ('code' in adopted) {
          settle(op, { op, state: 'failed', failure: adopted }, following);

          return;
        }

        workspace = adopted;
      }

      await launch(live, request, following, target, {
        place, modeId: CONFINED_MODES[target.tool], prompt: confinedBrief(target.tool, confined, lease.prompt), options: CONFINED_OPTIONS[target.tool],
        answer: { kind: 'reply', kept: CONFINED_KEPT }, cwd: workspace.directory, ...(startedFrom && { parent: startedFrom }),
      });
    } finally {
      following.landed();
    }
  }

  return judge;
}
