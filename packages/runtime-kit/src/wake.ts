import { WAKE_COMMAND } from '@teamai/runtime-protocol';

// ─── What a woken Codex member is told first ───
//
//  Codex runs a command in its sandbox, with no network and no write outside the checkout, unless it asks to run it
//  outside; teamai's command needs both (the team repo's origin, ~/.teamai). Codex asks the person only for such an
//  escalation, whatever mode its app starts it in, and no runtime grants it full access to another machine. So both
//  runtimes that wake members start a Codex member's first message with this line.
//

/** The line a woken Codex member's first message starts with: run teamai's command outside the sandbox, and who approves it. */
export function codexWakeLine(pool: string): string {
  return `teamai woke this agent to take one attempt of the fleet pool ${pool}. Run \`${WAKE_COMMAND}\` below with escalated permissions, outside the sandbox: `
    + 'it needs the network and writes ~/.teamai, which the sandbox blocks. Whoever watches this agent: approve that command when Codex asks, or the attempt waits here.';
}
