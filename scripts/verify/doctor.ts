/**
 * `doctor`'s probes, and `doctor --drivers`: what a driver claim needs on this machine, read-only but for `sbx ls` in a
 * world named, whose writes are recorded as sbx's. Each sandbox provider's readiness, the driver host command each step
 * runtime declares, each tool's cheapest model, and the keys present, by name. Loaded only by `doctor`.
 */
import fs from 'node:fs';
import os from 'node:os';
import { z } from 'zod';
import { collectEnvSecrets } from '@teamai/shared/redact';
import { PROVIDER_COMMANDS } from '../../packages/runtime-sandbox/src/provider-commands.js';
import { VERCEL_AUTH } from '../../packages/runtime-sandbox/src/providers/vercel.js';
import { priceTokens } from '../../src/token-usage/pricing.js';
import { captureOn } from './target.js';
import { hostCommand, recordWriters, runProbe, runtimeHostCommands, TOOL_COMMANDS, worldFiles, worldWritersFile, type World } from './world.js';

/**
 * What `argv` printed, or why it could not say: its command as a world's `tools` links it (`hostCommand`), run in the
 * harness's own environment, never a world's, and killed once it takes `timeoutMs`, which proves nothing about it.
 */
export function probeHostCommand(argv: readonly string[], { timeoutMs = 20_000 }: { timeoutMs?: number } = {}): { ok: true; first: string; stdout: string } | { ok: false; why: string } {
  const [name = 'true', ...args] = argv;
  let command: string | undefined;

  try {
    command = hostCommand(name);
  } catch (error) {
    return { ok: false, why: `NOT OBSERVED: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (command === undefined) return { ok: false, why: 'not installed' };
  const ran = runProbe({ command, args, shown: argv, cwd: os.tmpdir(), timeoutMs });

  if (ran.errno !== undefined) return { ok: false, why: ran.errno === 'ENOENT' ? 'not installed' : ran.why };

  if (ran.code !== 0) return { ok: false, why: ran.stderr.trim().split('\n').at(-1) || `exit ${ran.code}` };

  return { ok: true, first: ran.stdout.trim().split('\n')[0] ?? '', stdout: ran.stdout };
}

/** How each provider is asked whether it can run here: a new provider fails the type check until it has a row. */
const PROVIDER_READINESS = {
  docker: () => probeHostCommand([PROVIDER_COMMANDS.docker, 'info', '--format', 'up, server {{.ServerVersion}}']),
  podman: () => probeHostCommand([PROVIDER_COMMANDS.podman, 'info', '--format', 'up, server {{.Version.Version}}']),
  sbx: () => probeHostCommand([PROVIDER_COMMANDS.sbx, 'version']),
  bwrap: () => (process.platform === 'linux' ? probeHostCommand([PROVIDER_COMMANDS.bwrap, '--version']) : { ok: false, why: 'Linux only' }),
  seatbelt: () => (process.platform === 'darwin' && fs.existsSync(PROVIDER_COMMANDS.seatbelt) ? { ok: true, first: PROVIDER_COMMANDS.seatbelt, stdout: '' } : { ok: false, why: 'macOS only' }),
  vercel: () => {
    const present = VERCEL_AUTH.filter((name) => process.env[name]);

    return present.length > 0 ? { ok: true, first: `key present: ${present.join(', ')}`, stdout: '' } : { ok: false, why: `no key: none of ${VERCEL_AUTH.join(', ')} is set, and reap says UNVERIFIABLE` };
  },
} satisfies Record<keyof typeof PROVIDER_COMMANDS, () => ReturnType<typeof probeHostCommand>>;

const CatalogSchema = z.object({ models: z.array(z.looseObject({ slug: z.string(), visibility: z.string().optional() })) });

/** Price of a million tokens in and out, by teamai's own price table, or undefined when it has none. */
function priceOf(model: string): number | undefined {
  return priceTokens({ model, tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 } })?.costMicros;
}

/** The cheapest model by teamai's prices among those a model catalog (`codex debug models`) lists for this login. */
export function cheapestListed(catalog: string): string | undefined {
  let parsed: z.infer<typeof CatalogSchema>;

  try {
    parsed = CatalogSchema.parse(JSON.parse(catalog));
  } catch {
    return undefined;
  }

  const priced = parsed.models.filter((model) => model.visibility === 'list').flatMap((model) => {
    const price = priceOf(model.slug);

    return price === undefined ? [] : [{ slug: model.slug, price }];
  });

  return priced.toSorted((a, b) => a.price - b.price)[0]?.slug;
}

/** Each tool's cheapest model, the one a world's real run uses: by name, or asked of the tool's own catalog for this login. */
const CHEAPEST_MODEL = {
  claude: () => 'haiku',
  codex: () => {
    const catalog = probeHostCommand(['codex', 'debug', 'models']);

    return catalog.ok ? cheapestListed(catalog.stdout) : undefined;
  },
  codebuddy: () => undefined,
  opencode: () => undefined,
} satisfies Record<(typeof TOOL_COMMANDS)[number], () => string | undefined>;

/**
 * The line that says sbx is not signed in for the install `at` names (`<run>` or `<run>@<member>`), when what sbx `said`
 * is that refusal, which ends with the command that signs in: `try: sbx login`. Doctor and the observer print the same line for it.
 */
export function sbxNotSignedIn(at: string, said: string): string | undefined {
  return /\bsbx login\b/.test(said) ? `sandbox sbx: installed, not signed in in this world; sign in with \`npm run -s verify -- sh ${at} sbx login\`. Claims on it are UNVERIFIABLE until then` : undefined;
}

/** The line `doctor <run> --drivers` gives sbx from what `sbx ls --no-input` answered in world `runId`. */
export function sbxInWorld(runId: string, ran: { code: number | null; why: string }) {
  if (ran.code === 0) return { good: true, text: 'sandbox sbx: signed in in this world' };
  const notSignedIn = sbxNotSignedIn(runId, ran.why);

  if (notSignedIn !== undefined) return { good: false, text: notSignedIn };

  return { good: false, text: `sandbox sbx: \`sbx ls\` failed in this world (${ran.why}): claims on it are UNVERIFIABLE here` };
}

/**
 * Asks sbx in `world`, from its own HOME, whether it is signed in there. What sbx writes there is its own, as when a
 * maintainer runs it with `sh`, so it is recorded as sbx's.
 */
function askSbxIn(world: World) {
  const argv = [PROVIDER_COMMANDS.sbx, 'ls', '--json', '--no-input'];
  const before = worldFiles(world);
  const ran = captureOn(world, { kind: 'world' }, argv);
  recordWriters(worldWritersFile(world), argv, before, worldFiles(world));

  return sbxInWorld(world.runId, ran);
}

/** Where a world's `tools` finds `name` on this machine, or why it does not. */
function foundHere(name: string): { ok: true; at: string } | { ok: false; why: string } {
  try {
    const at = hostCommand(name);

    return at === undefined ? { ok: false, why: 'not on PATH' } : { ok: true, at };
  } catch (error) {
    return { ok: false, why: `NOT OBSERVED: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Prints the drivers section of doctor; with `world`, what sbx answers in it. */
export async function doctorDrivers(line: (good: boolean, text: string) => void, { world }: { world?: World } = {}): Promise<void> {
  for (const [provider, ready] of Object.entries(PROVIDER_READINESS)) {
    const answer = ready();
    line(answer.ok, answer.ok ? `sandbox ${provider}: ${answer.first}` : `sandbox ${provider}: ${answer.why}: claims on it are UNVERIFIABLE here`);

    if (provider !== 'sbx' || !answer.ok) continue;
    const signIn = world === undefined ? { good: false, text: 'sandbox sbx: signed in or not is per world; `doctor <run> --drivers` asks in that world' } : askSbxIn(world);
    line(signIn.good, signIn.text);
  }

  for (const { runtime, commands } of await runtimeHostCommands()) {
    for (const command of commands) {
      const found = foundHere(command);
      line(found.ok, found.ok ? `${runtime} runs ${command}: ${found.at}` : `${runtime} runs ${command}, ${found.why}: claims on it are UNVERIFIABLE here`);
    }
  }

  for (const [tool, cheapest] of Object.entries(CHEAPEST_MODEL)) {
    const model = foundHere(tool).ok ? cheapest() : undefined;
    line(model !== undefined, model === undefined ? `${tool}: no cheapest model known here; name one with the tool's model option` : `${tool}: cheapest model ${model}`);
  }

  const keys = Object.keys(collectEnvSecrets(process.env)).toSorted();
  line(true, keys.length === 0 ? 'keys present: none' : `keys present (names only): ${keys.join(', ')}`);
}
