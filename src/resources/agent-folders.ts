/**
 * Agent folders: `agents/[<ns>/]<name>/AGENT.md` and the support files beside it. Each tool still receives one agent
 * file from `AGENT.md`, as from a legacy `agents/<name>.md`, whose text names the folder through `${TEAMAI_AGENT_DIR}`;
 * pull renders that to where the tool reads the folder's files, and delivers the folder there (`DeliveredFolders`).
 */
import path from 'node:path';
import type { DeliveryLedger } from './delivered-copies.js';
import { DeliveredFolders, type DeliveredFolderRef } from './delivered-folders.js';
import { FolderFiles } from './folder-files.js';
import { FOLDER_MARKERS } from '../folder-markers.js';
import { baseDescriptorOf, folderReachOf } from '../tool-registry.js';
import type { CopyOrigin, LocalConfig, ResourceItem } from '../types.js';
import { listDirs, listFiles, pathExists, readFileSafe } from '../utils/fs.js';
import { warnOnce } from '../utils/warn-once.js';

/** An agent folder, as the team repo holds it: `item.sourcePath` is its `AGENT.md`. */
type AgentFolder = ResourceItem & { readonly folder: true };

function isFolder(agent: ResourceItem): agent is AgentFolder {
  return agent.folder === true;
}

/** Where the agent folder sits in the agents directory: its namespace and its own name. */
function refOf(agent: Pick<ResourceItem, 'name' | 'namespace'>): DeliveredFolderRef {
  return { type: 'agents', namespace: agent.namespace ?? null, name: agent.name };
}

/** Where pull delivers the agent folder `agent` in `localConfig`'s scope. */
function pathOf(localConfig: LocalConfig, agent: Pick<ResourceItem, 'name' | 'namespace'>): string {
  return DeliveredFolders.pathOf(localConfig, refOf(agent));
}

/** `text` with `${TEAMAI_AGENT_DIR}` naming `agent`'s folder where `tool` reads it (`DeliveredFolders.renderFor`). */
function render(text: string, at: { readonly localConfig: LocalConfig; readonly agent: AgentFolder; readonly tool: string }): string {
  return DeliveredFolders.renderFor(text, { localConfig: at.localConfig, ref: refOf(at.agent), tool: at.tool });
}

/**
 * Deliver `agent`'s folder to `localConfig`'s scope, recorded in `ledger`, before the copies that name its files are
 * written. In user scope, each of `tools` (the tools receiving the agent) that cannot read the data home is named once.
 * The folder keeps the files an earlier version had, which a copy the member edited may still name. Throws when the
 * folder cannot be read or written; the caller keeps what it installed.
 */
async function deliver(input: {
  readonly localConfig: LocalConfig;
  readonly agent: AgentFolder;
  readonly tools: readonly string[];
  readonly ledger: DeliveryLedger | undefined;
}): Promise<void> {
  const { localConfig, agent } = input;
  const read = await FolderFiles.read(path.dirname(agent.sourcePath));

  if (read.kind === 'invalid') {
    throw new Error(`${path.posix.dirname(agent.relativePath)}/ is not delivered: ${read.problems.map(FolderFiles.describe).join(', ')}. `
      + 'Keep only regular files in an agent folder in the team repo, then run teamai pull again');
  }

  if (DeliveredFolders.worktreeRoot(localConfig) === null) {
    for (const tool of input.tools.filter((name) => folderReachOf(name).reach === 'copy')) {
      warnOnce(`${tool} may ask before it reads the files of user-scope agent folders in ${path.join(DeliveredFolders.root(localConfig, 'agents'), 'agents')}: `
        + 'teamai grants it no access there, and a user-scope agent has no project to copy them into. Allow the directory in its settings, or share these agents from a project.');
    }
  }

  const dest = pathOf(localConfig, agent);

  await DeliveredFolders.sync({ localConfig, type: 'agents', folders: [{ dest, files: read.files, earlierFiles: 'keep' }], ledger: input.ledger, prune: false });
}

/**
 * Remove each agent folder `localConfig`'s scope delivered that is not one of `kept` (the agents this pull delivers)
 * and that no file in `copyDirs` (each tool's agents directory) names: a copy the member kept, edited after the team
 * dropped its agent, keeps the folder its text names.
 */
async function prune(input: {
  readonly localConfig: LocalConfig;
  readonly kept: readonly ResourceItem[];
  readonly copyDirs: readonly string[];
  readonly ledger: DeliveryLedger | undefined;
}): Promise<void> {
  const { localConfig } = input;

  if ((await listDirs(path.join(DeliveredFolders.root(localConfig, 'agents'), 'agents'))).length === 0) return;
  const named = await namedBy(localConfig, input.copyDirs);
  const kept = input.kept.filter(isFolder).map((agent) => pathOf(localConfig, agent));

  await DeliveredFolders.prune({ localConfig, type: 'agents', keep: [...kept, ...named], ledger: input.ledger });
}

/** The delivered agent folders of `localConfig`'s scope that a file in `copyDirs` (each tool's agents directory) names. */
async function namedBy(localConfig: LocalConfig, copyDirs: readonly string[]): Promise<string[]> {
  const texts: string[] = [];

  for (const dir of copyDirs) {
    for (const file of await listFiles(dir)) {
      const text = await readFileSafe(path.join(dir, file));

      if (text !== null) texts.push(text);
    }
  }

  return DeliveredFolders.namedIn({ root: DeliveredFolders.root(localConfig, 'agents'), type: 'agents', texts });
}

/**
 * How a copy of agent `stem` in `tool`'s agents directory, with no delivery record, is proven a copy pull rendered from
 * an agent folder (#993): it holds a version of a team `agents/[<ns>/]<stem>/AGENT.md`, its folder named where `tool`
 * reads it in `localConfig`'s scope, as `render` writes it.
 */
function origin(localConfig: LocalConfig, stem: string, tool: string): CopyOrigin {
  const { marker } = FOLDER_MARKERS.agents;

  return {
    repoPath: localConfig.repo.localPath,
    pathspec: `:(glob)agents/**/${stem}/${marker}`,
    renders: [(content, version) => {
      if (baseDescriptorOf(tool)?.legacyAgentMd !== true) return null;
      const namespace = path.posix.dirname(path.posix.dirname(version.path)).slice('agents/'.length);
      const ref: DeliveredFolderRef = { type: 'agents', namespace: namespace === '' ? null : namespace, name: stem };

      return DeliveredFolders.renderFor(content.toString('utf8'), { localConfig, ref, tool });
    }],
  };
}

/** Whether `localConfig`'s scope holds a delivered agent folder named `name`, in any namespace. */
async function isDelivered(localConfig: LocalConfig, name: string): Promise<boolean> {
  const agentsRoot = path.join(DeliveredFolders.root(localConfig, 'agents'), 'agents');

  const { marker } = FOLDER_MARKERS.agents;

  for (const parent of [agentsRoot, ...(await listDirs(agentsRoot)).map((namespace) => path.join(agentsRoot, namespace))]) {
    if (await pathExists(path.join(parent, name, marker))) return true;
  }

  return false;
}

export const AgentFolders = { isFolder, pathOf, render, origin, deliver, prune, namedBy, isDelivered } as const;
