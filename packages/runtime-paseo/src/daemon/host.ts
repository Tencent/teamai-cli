import type { HostSummary, PaseoAgentConfig, PaseoApi, PaseoWorkspace } from '@getpaseo/client';
import { PASEO_TOOLS, type PaseoTool } from '../providers.js';
import type { PaseoClient } from './client.js';

// ─── Another Paseo daemon, routed through this one ───────
//
//  The daemons the member saved on this one as hosts (`paseo host add`), and a connection to one of them that this
//  daemon routes, as the Paseo app reaches a saved host: no address, credential or option of teamai's own.
//

/** A host the daemon saved, as it lists it: its label, its server once it was reached, and whether it is online now. */
export interface SavedHost {
  label: string;
  serverId: string | null;
  status: HostSummary['status'];
}

/** A saved host reached through this daemon. */
export interface Host {
  /** The workspace whose git checkout's origin `isOf` takes, on any page of the host's workspaces. */
  checkoutOf(isOf: (origin: string) => boolean): Promise<PaseoWorkspace | undefined>;
  /** The tool a member starts on, and its provider and model: the default model of the first of teamai's tools the host has, if any. */
  memberProvider(): Promise<{ tool: PaseoTool; provider: string } | undefined>;
  /** Starts an agent in `workspace` whose first prompt is `prompt`, with the tool's launch `options`; a repeated `agentId` starts none. */
  launch(agent: { workspace: PaseoWorkspace; agentId: string; title: string; prompt: string; provider: string; options: PaseoAgentConfig['options']; labels: Record<string, string> }): Promise<void>;
  /** The Paseo app's link to the host's agent. */
  link(agentId: string): string;
  close(): Promise<void>;
}

/** The hosts the daemon behind `api` saved, in its order. */
export async function savedHosts(api: PaseoApi): Promise<SavedHost[]> {
  const { hosts } = await api.hosts.list();

  return hosts.map((host) => ({ label: host.label ?? host.targetDescription, serverId: host.serverId, status: host.status }));
}

/** The saved host `serverId`, reached over a route of the daemon behind `api`. */
export async function routedHost(api: PaseoApi, paseo: PaseoClient, serverId: string): Promise<Host> {
  const remote = await api.hosts.client(serverId);

  return {
    async checkoutOf(isOf) {
      for (let cursor: string | undefined; ;) {
        const listed = await remote.workspaces.list({ page: { limit: 200, ...(cursor !== undefined && { cursor }) } });
        // Paseo 0.14.0 reports a checkout's origin in its git runtime, and leaves the placement's null (recorded).
        const found = listed.entries.find((entry) => entry.archivingAt === null && [entry.gitRuntime?.remoteUrl, entry.project?.checkout.remoteUrl].some((origin) => origin !== null && origin !== undefined && isOf(origin)));

        if (found) return found;
        const next = listed.pageInfo.nextCursor;

        if (!listed.pageInfo.hasMore || !next) return undefined;
        cursor = next;
      }
    },
    async memberProvider() {
      const { providers } = await remote.providers.listAvailable();
      const tool = PASEO_TOOLS.find((name) => providers.some((entry) => entry.provider === name && entry.available));

      if (tool === undefined) return undefined;
      const { models = [] } = await remote.providers.listModels(tool);
      const model = models.find((one) => one.isDefault === true) ?? models[0];

      return model && { tool, provider: `${tool}/${model.id}` };
    },
    async launch({ workspace, agentId, title, prompt, provider, options, labels }) {
      await remote.workspaces.ref(workspace).agents.create({ agentId, idempotencyKey: agentId, title, prompt, labels, config: { provider, ...(options && { options }) } });
    },
    link: (agentId) => paseo.buildAgentDeepLink({ serverId, agentId }),
    close: () => remote.dispose(),
  };
}
