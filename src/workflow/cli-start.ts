// The CLI's own automatic starts of a workflow: a scoring pass, a finished session's workflow, `workflow start`.
// It imports only types, so a scorer or the session flow reaches it without importing the workflow protocol.
import type { RunMode } from '../launch-context.js';
import type { WorkflowClient } from './protocol.js';
import type { WorkflowEnvelope } from './types.js';

/**
 * Starts `name` as one of the CLI's own automatic starts, in run mode `mode`: with no agent evidence, so no agent gave its
 * inputs, and recorded as started by `cli`, which hand labels and policy overrides never trust as a person.
 */
export function startAsCli(client: Pick<WorkflowClient, 'start'>, name: string, { mode, ...options }: Omit<Parameters<WorkflowClient['start']>[1], 'caller' | 'startedBy' | 'instead'> & { mode: RunMode }): Promise<WorkflowEnvelope> {
  return client.start(name, { ...options, caller: { evidence: { kind: 'none' }, confirmed: false, mode }, startedBy: 'cli' });
}
