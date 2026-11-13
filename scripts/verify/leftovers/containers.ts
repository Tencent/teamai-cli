/**
 * Containers, networks and images teamai labelled (`teamai.owner`) on each container engine that is up, tied to a world by
 * the owner journal of one of its HOMEs or by a mount of one of its paths. An engine is asked, never started.
 */
import { CONTAINER_ENGINES } from '../../../packages/runtime-sandbox/src/options.js';
import { PROVIDER_COMMANDS } from '../../../packages/runtime-sandbox/src/provider-commands.js';
import { attributeLeftover, probeHere, type Finding, type LeftoverKind, type Observed, type WorldTies } from '../leftovers.js';

const OWNER = 'teamai.owner';

/** `ps --format` lines: id, name, owner, run and state, tab-separated. */
export function parseContainers(stdout: string): Array<{ id: string; name: string; owner: string; run: string; state: string }> {
  return stdout.split('\n').flatMap((line) => {
    const [id = '', name = '', owner = '', run = '', state = ''] = line.split('\t');

    return id === '' ? [] : [{ id, name, owner, run, state }];
  });
}

/** `inspect --format` lines: id, then the source of each mount, tab-separated. */
export function parseMounts(stdout: string): Map<string, string[]> {
  return new Map(stdout.split('\n').flatMap((line) => {
    const [id = '', ...sources] = line.split('\t');

    return id === '' ? [] : [[id.slice(0, 12), sources.filter((source) => source !== '')] as const];
  }));
}

/** `ls --format` lines of a network (id, name and owner) or an image (id and name), tab-separated. */
export function parseLabelled(stdout: string): Array<{ id: string; name: string; owner: string }> {
  return stdout.split('\n').flatMap((line) => {
    const [id = '', name = '', owner = ''] = line.split('\t');

    return id === '' ? [] : [{ id, name, owner }];
  });
}

/**
 * The images teamai labelled, one per name an engine lists, with their owner. Docker 29's `image ls --format` has no
 * `.Label`/`.Labels` (podman's has no `.Label`), so the listing gives ids and names and `image inspect` gives each owner.
 */
function labelledImages(command: string): { kind: 'listed'; images: Array<{ id: string; name: string; owner: string }> } | { kind: 'failed'; why: string } {
  const ls = probeHere([command, 'image', 'ls', '--filter', `label=${OWNER}`, '--format', '{{.ID}}\t{{.Repository}}:{{.Tag}}']);

  if (ls.kind !== 'ran' || ls.code !== 0) return { kind: 'failed', why: `\`${command} image ls\` failed${ls.kind === 'ran' ? `: ${ls.why}` : ''}` };
  const listed = parseLabelled(ls.stdout);

  if (listed.length === 0) return { kind: 'listed', images: [] };
  const inspected = probeHere([command, 'image', 'inspect', '--format', `{{.Id}}\t{{index .Config.Labels "${OWNER}"}}`, ...new Set(listed.map((one) => one.id))]);

  // An image removed since the listing is gone, not unobserved: docker inspects the others and says only that of it.
  const isOnlyGone = inspected.kind === 'ran' && inspected.code === 1 && inspected.stderr.trim().split('\n').every((line) => line.startsWith('Error response from daemon: No such image: '));

  if (inspected.kind !== 'ran' || (inspected.code !== 0 && !isOnlyGone)) return { kind: 'failed', why: `\`${command} image inspect\` failed${inspected.kind === 'ran' ? `: ${inspected.why}` : ''}` };
  const owners = new Map(inspected.stdout.split('\n').map((line) => line.split('\t')).map(([id = '', owner = '']) => [shortImageId(id), owner]));
  const present = isOnlyGone ? listed.filter((one) => owners.has(shortImageId(one.id))) : listed;

  return { kind: 'listed', images: present.map((one) => ({ id: one.id, name: one.name, owner: owners.get(shortImageId(one.id)) ?? '' })) };
}

/** An image id as `image ls` shows it: docker's `inspect` prefixes `sha256:` and podman's does not; both list 12 hex digits. */
function shortImageId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

function onEngine(engine: (typeof CONTAINER_ENGINES)[number], self: WorldTies, others: readonly WorldTies[]): Observed[] {
  const command = PROVIDER_COMMANDS[engine];
  const info = probeHere([command, 'info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 });

  if (info.kind === 'missing') return [{ kind: 'observed', findings: [], notes: [`${engine}: not installed here`] }];

  if (info.code !== 0) return [{ kind: 'not_observed', what: `${engine} containers`, why: `\`${engine} info\` failed, so the engine is not up: ${info.why}` }];
  const listed = probeHere([command, 'ps', '-a', '--no-trunc', '--filter', `label=${OWNER}`, '--format', `{{.ID}}\t{{.Names}}\t{{.Label "${OWNER}"}}\t{{.Label "teamai.run"}}\t{{.State}}`]);

  if (listed.kind !== 'ran' || listed.code !== 0) return [{ kind: 'not_observed', what: `${engine} containers`, why: `\`${engine} ps\` failed: ${listed.kind === 'ran' ? listed.why : 'not installed'}` }];
  const found = parseContainers(listed.stdout);
  const inspected = found.length === 0 ? undefined : probeHere([command, 'inspect', '--format', `{{.Id}}{{range .Mounts}}\t{{.Source}}{{end}}`, ...found.map((one) => one.id)]);
  const mounts = inspected?.kind === 'ran' && inspected.code === 0 ? parseMounts(inspected.stdout) : new Map<string, string[]>();
  const unobserved: Observed[] = inspected !== undefined && mounts.size === 0 ? [{ kind: 'not_observed', what: `mounts of ${engine} containers`, why: `\`${engine} inspect\` failed` }] : [];
  const tie = (owner: string, paths: readonly string[], runs: readonly string[]) => attributeLeftover({ paths, journals: owner === '' ? [] : [owner], runs, marked: true }, self, others);

  const findings: Finding[] = found.map((one) => ({
    what: `${engine} container ${one.name} (${one.state})`,
    attribution: tie(one.owner, mounts.get(one.id.slice(0, 12)) ?? [], one.run === '' ? [] : [one.run]),
    remove: [command, 'rm', '-f', one.id],
  }));

  // docker's `network ls` gives one label as `.Label`; podman's has no `.Label`, and gives `.Labels` as a map.
  const networkOwner = engine === 'docker' ? `{{.Label "${OWNER}"}}` : `{{index .Labels "${OWNER}"}}`;
  const networks = probeHere([command, 'network', 'ls', '--filter', `label=${OWNER}`, '--format', `{{.ID}}\t{{.Name}}\t${networkOwner}`]);

  if (networks.kind === 'ran' && networks.code === 0) {
    findings.push(...parseLabelled(networks.stdout).map((one) => ({ what: `${engine} network ${one.name}`, attribution: tie(one.owner, [], []), remove: [command, 'network', 'rm', one.id] })));
  } else {
    unobserved.push({ kind: 'not_observed', what: `${engine} networks`, why: `\`${engine} network ls\` failed${networks.kind === 'ran' ? `: ${networks.why}` : ''}` });
  }

  const images = labelledImages(command);

  if (images.kind === 'listed') {
    // By name: an engine refuses to remove by id an image that more than one name holds. One with no tag, which `ls`
    // shows as `<repo>:<none>` or `<none>:<none>`, goes by its id.
    findings.push(...images.images.map((one) => ({ what: `${engine} image ${one.name}`, attribution: tie(one.owner, [], []), remove: [command, 'image', 'rm', one.name.endsWith(':<none>') ? one.id : one.name] })));
  } else {
    unobserved.push({ kind: 'not_observed', what: `${engine} images`, why: images.why });
  }

  return [{ kind: 'observed', findings, notes: [] }, ...unobserved];
}

export const containers: LeftoverKind = {
  title: 'teamai container, network or image',
  onCleanup: { kind: 'remove' },
  observe({ self, others }) {
    return Promise.resolve(CONTAINER_ENGINES.flatMap((engine) => onEngine(engine, self, others)));
  },
};
