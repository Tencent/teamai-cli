import { z } from 'zod';
import type { RuntimeFailure, RuntimeOptions } from '@teamai/runtime-protocol';

// ─── Options, as a driver definition passes them at `init` ───
//
//  A `bad_option` message ends without a period: teamai quotes it inside its own sentence.
//
//    runtimes:
//      - use: sandbox
//        options:
//          provider: sbx                    # sbx | docker | podman | seatbelt | bwrap | vercel
//          agent: claude                    # sbx, optional: the agent template (claude, codex) or a kit reference;
//                                           # unset, each attempt starts from its own tool's template
//      - use: sandbox
//        options:
//          provider: docker
//          image: ghcr.io/acme/agent:1      # docker, podman: a prebuilt image holding the tools
//      - use: sandbox
//        options:
//          provider: seatbelt               # seatbelt (macOS), bwrap (Linux): this machine's own tools, no other key
//      - use: sandbox
//        options:
//          provider: vercel                 # a hosted sandbox per attempt
//          timeout: 2h                      # optional: its lifetime, 1m to 5h; unset, past the attempt's deadline
//          provider_auth: { VERCEL_TOKEN: file:~/.config/vercel-token }   # optional: where the Vercel sign-in is read
//          warm: { prepare: npm ci --ignore-scripts, cache: [package-lock.json], expiration: 30d }   # optional
//
//  These options come from a sandbox profile, `sandboxes/<name>.yaml` or `sandboxes/<name>/SANDBOX.yaml`, which teamai
//  passes with `profile`: its name, its revision, and its folder when it is one, which `warm.containerfile` is then
//  inside. teamai reads `credentials` and `max_parallel` itself and never passes them here; it gives the credentials on
//  `open`. Each provider has its own schema, and a key it does not take fails with `bad_option` naming it.
//

/** The container engines this version runs. */
export const CONTAINER_ENGINES = ['docker', 'podman'] as const;

export type ContainerEngine = (typeof CONTAINER_ENGINES)[number];

/** The native sandboxes of the operating system, which run each exec on this machine's own tools. */
export const NATIVE_SANDBOXES = ['seatbelt', 'bwrap'] as const;

export type NativeProvider = (typeof NATIVE_SANDBOXES)[number];

/** The providers this version runs. */
const PROVIDERS = ['sbx', ...CONTAINER_ENGINES, ...NATIVE_SANDBOXES, 'vercel'] as const;

export type SandboxProviderName = (typeof PROVIDERS)[number];

const CACHE = 'List the manifests and lockfiles that key the warm image, relative to the checkout, for example cache: [package.json, package-lock.json]';

const CacheSchema = z.array(z.string().min(1, CACHE), { error: CACHE }).min(1, CACHE);

const PrepareSchema = z.string({ error: 'Give the command that installs the dependencies, for example prepare: npm ci --ignore-scripts' }).min(1);

/** A warm image made by running `prepare` on the base, keyed by the `cache` files. */
const PreparedWarmSchema = z.strictObject({ prepare: PrepareSchema, cache: CacheSchema });

/**
 * A warm image on docker or podman: `prepare` run on the base, or a `containerfile` built with only the `cache` files in
 * its context, never both.
 */
const ContainerWarmSchema = z.strictObject({
  prepare: PrepareSchema.optional(),
  containerfile: z.string({ error: 'Give the path of the Containerfile, relative to the checkout' }).min(1).optional(),
  cache: CacheSchema,
}).transform(({ prepare, containerfile, cache }, context) => {
  if (prepare !== undefined && containerfile === undefined) return { prepare, cache };

  if (containerfile !== undefined && prepare === undefined) return { containerfile, cache };
  context.addIssue({ code: 'custom', message: 'Give warm either prepare or containerfile, not both and not neither', path: [] });

  return z.NEVER;
});

/** How a warm image is made: by a prepare command, or by a Containerfile (docker and podman only). */
export type WarmOptions = z.infer<typeof ContainerWarmSchema>;

const ContainerOptionsSchema = z.strictObject({
  provider: z.enum(CONTAINER_ENGINES),
  image: z.string({ error: 'Name the prebuilt image that holds the tools, for example image: ghcr.io/acme/agent:1' }).min(1),
  warm: ContainerWarmSchema.optional(),
});

const NAME_AN_AGENT = "Name the agent whose template each sandbox starts from: agent: claude, agent: codex, or a kit reference that brings the tools (sbx's bare shell template holds no agent), or leave agent out to start each attempt from its own tool's template";

const SbxOptionsSchema = z.strictObject({
  provider: z.literal('sbx'),
  agent: z.string({ error: NAME_AN_AGENT }).min(1, NAME_AN_AGENT).refine((agent) => agent !== 'shell', NAME_AN_AGENT).optional(),
  warm: PreparedWarmSchema.optional(),
});

/** seatbelt and bwrap take only their provider: the tools are this machine's own, on its PATH. */
const NativeOptionsSchema = z.strictObject({ provider: z.enum(NATIVE_SANDBOXES) });

/** Where the runtime reads one value of the provider's own sign-in on the host: a variable, or a file. */
const AuthSourceSchema = z.string().regex(/^(?:env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/, 'Read it from a variable or a file: env:<NAME> or file:<path>');

const LIFETIME = 'Give the sandbox\'s lifetime as a duration Vercel takes, from 1m to 5h, for example timeout: 2h';

/** A duration such as `90s`, `30m` or `2h`, in milliseconds, within what Vercel gives a sandbox. */
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

const LifetimeSchema = z.string({ error: LIFETIME }).regex(/^\d+[smh]$/, LIFETIME)
  .transform((duration) => Number(duration.slice(0, -1)) * UNIT_MS[z.enum(['s', 'm', 'h']).parse(duration.slice(-1))])
  .refine((ms) => ms >= 60_000 && ms <= 5 * 3_600_000, LIFETIME);

const KEPT_FOR = 'Give how long Vercel keeps the warm snapshot after its last use, in days or hours, for example expiration: 30d';

/** How long Vercel keeps a warm snapshot after its last use, such as `30d` or `12h`, in milliseconds: an hour at least. */
const ExpirationSchema = z.string({ error: KEPT_FOR }).regex(/^\d+[dh]$/, KEPT_FOR)
  .transform((duration) => Number(duration.slice(0, -1)) * (duration.endsWith('d') ? 24 : 1) * UNIT_MS.h)
  .refine((ms) => ms >= UNIT_MS.h, KEPT_FOR);

/** A warm snapshot on vercel: `prepare` run in a scratch sandbox on the `cache` files, kept `expiration` (30d unset). */
const VercelWarmSchema = z.strictObject({ prepare: PrepareSchema, cache: CacheSchema, expiration: ExpirationSchema.optional() });

export type VercelWarmOptions = z.infer<typeof VercelWarmSchema>;

/**
 * vercel: a hosted sandbox per attempt. `runtime` is Vercel's image (its default ships Claude); `timeout` the sandbox's
 * lifetime; `provider_auth` where each value of the Vercel sign-in is read on the host, when not from the variable of its
 * own name.
 */
const VercelOptionsSchema = z.strictObject({
  provider: z.literal('vercel'),
  runtime: z.string().min(1, 'Name the Vercel image, for example runtime: node24').optional(),
  timeout: LifetimeSchema.optional(),
  warm: VercelWarmSchema.optional(),
  provider_auth: z.strictObject({
    VERCEL_TOKEN: AuthSourceSchema.optional(),
    VERCEL_TEAM_ID: AuthSourceSchema.optional(),
    VERCEL_PROJECT_ID: AuthSourceSchema.optional(),
    VERCEL_OIDC_TOKEN: AuthSourceSchema.optional(),
  }).optional(),
});

export type VercelOptions = z.infer<typeof VercelOptionsSchema>;

const SCHEMAS = { sbx: SbxOptionsSchema, docker: ContainerOptionsSchema, podman: ContainerOptionsSchema, seatbelt: NativeOptionsSchema, bwrap: NativeOptionsSchema, vercel: VercelOptionsSchema } satisfies Record<(typeof PROVIDERS)[number], z.ZodObject>;

export type SandboxOptions = z.infer<typeof ContainerOptionsSchema> | z.infer<typeof SbxOptionsSchema> | z.infer<typeof NativeOptionsSchema> | VercelOptions;

/** The sandbox profile the options come from, as teamai gives it: its name, its revision, and its folder when it is one. */
const ProfileSchema = z.strictObject({ name: z.string().min(1), revision: z.string().min(1), folder: z.string().min(1).optional() });

export type ProfileOption = z.infer<typeof ProfileSchema>;

/** The provider's options, with the profile they come from when teamai named one. */
export type ParsedOptions = SandboxOptions & { readonly profile?: ProfileOption };

/** `schema` without what wraps an object: optional, and a transform's input. */
function bare(schema: z.core.$ZodType): z.core.$ZodType {
  if (schema instanceof z.ZodOptional) return bare(schema.unwrap());

  return schema instanceof z.ZodPipe ? bare(schema.in) : schema;
}

/** The keys the object at `at` in `schema` takes, found in the schema itself, so a new nested option needs no list. */
function keysAt(schema: z.core.$ZodType, at: readonly PropertyKey[]): string[] {
  const [first, ...rest] = at;
  const node = bare(schema);

  if (!(node instanceof z.ZodObject)) return [];

  if (first === undefined) return Object.keys(node.shape);
  const next = node.shape[String(first)];

  return next === undefined ? [] : keysAt(next, rest);
}

/** What a key `issue` says no option takes means, naming the keys there are; undefined for another issue. */
function unknownKeyMessage(issue: z.core.$ZodIssue | undefined, provider: (typeof PROVIDERS)[number], schema: z.ZodObject): string | undefined {
  if (issue?.code !== 'unrecognized_keys') return undefined;

  if (issue.path.length === 0) return `Provider ${provider} takes no option "${issue.keys[0]}". It takes: ${keysAt(schema, []).join(', ')}`;

  return `On provider ${provider}, ${issue.path.join('.')} takes no key "${issue.keys[0]}". It takes: ${keysAt(schema, issue.path).join(', ')}`;
}

/** Parses a definition's options, or says which key is wrong and why. */
export function parseOptions(given: RuntimeOptions): { ok: true; options: ParsedOptions } | { ok: false; failure: RuntimeFailure } {
  const { profile: named, ...raw } = given;
  const profile = named === undefined ? undefined : ProfileSchema.safeParse(named);

  if (profile?.success === false) return { ok: false, failure: { code: 'bad_option', key: 'profile', message: 'teamai names the sandbox profile as { name, revision, folder }; update teamai and its runtime together' } };
  const provider = z.enum(PROVIDERS).safeParse(raw.provider);

  if (!provider.success) {
    return { ok: false, failure: { code: 'bad_option', key: 'provider', message: `Set provider to sbx, docker, podman, seatbelt, bwrap or vercel${raw.provider === undefined ? '' : `, not ${JSON.stringify(raw.provider)}`}` } };
  }

  const schema = SCHEMAS[provider.data];
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    // A misspelled key is named before the key it was meant to be, which then reads as missing.
    const { issues } = parsed.error;
    const issue = issues.find((candidate) => candidate.code === 'unrecognized_keys') ?? issues[0];
    const key = issue?.code === 'unrecognized_keys' ? [...issue.path, ...issue.keys.slice(0, 1)].join('.') : issue?.path.join('.');
    const message = unknownKeyMessage(issue, provider.data, schema) ?? issue?.message ?? 'Invalid option';

    return { ok: false, failure: { code: 'bad_option', key: key || 'options', message } };
  }

  return { ok: true, options: { ...parsed.data, ...(profile?.data && { profile: profile.data }) } };
}
