import { fitReason, type InitCredentials, type InitInstance } from '@teamai/runtime-protocol';
import type { GatewayVariables } from '@teamai/tool-core/launch';
import { SIGN_INS } from '@teamai/tool-definitions';
import type { Unavailable } from './provider.js';
import type { LAUNCHABLE } from './providers/cli.js';

// ─── Whether a tool can sign in inside a sandbox ─────────
//
//  A sandbox holds none of the member's own logins: a Claude login in the macOS Keychain or in ~/.claude, or Codex's
//  daily ~/.codex, never crosses into it. A tool is offered only when it can sign in there, the first that holds:
//
//    sbx      the service sbx's proxy holds a login for (`sbx secret ls`), which it injects and never lets in
//    teamai   a sign-in variable teamai gives each of the tool's execs by name (`init.credentials.env`)
//             a login teamai copies into the attempt's tool home (`init.credentials.logins`, `codex: login`)
//    free     OpenCode, whose free models need no sign-in
//
//  Otherwise a step would start and stop at the tool's own "Not logged in", whose next step cannot be followed there.
//  A tool that cannot sign in is left out of `can.tools` and listed in `init`'s `unavailable` with how to sign it in,
//  which teamai shows on a step that runs on it. The runtime still starts, so command steps run with no tool signed in.
//

/** The providers a tool signs in on, which decides how to sign it in. */
export type SignInProvider = 'sbx' | 'docker' | 'podman' | 'seatbelt' | 'bwrap' | 'vercel';

/**
 * How a tool signs in inside a sandbox: with a credential teamai gives or a login sbx keeps (`credentials`), or with
 * nothing, as OpenCode runs its free models (`free`).
 */
type SignIn = { by: 'free' } | {
  by: 'credentials';
  /** The variables the tool signs in with, as teamai finds them (the tool launch's `signIn`). */
  env: readonly string[];
  /** The sbx service whose stored login sbx's proxy injects for it, when sbx keeps one. */
  sbx?: string;
  /** How to sign it in, as the rest of a sentence that starts with the tool's name, per provider. */
  hint: Record<SignInProvider, string>;
  /** The variable that points the tool at a gateway, and the token it signs in to that gateway with, when it reads one. */
  gateway?: GatewayVariables;
};

const CLAUDE_TOKEN = 'run `claude setup-token` and add CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN to the sandbox\'s credentials (or an API key, ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY)';

const CLAUDE_IN_A_CONTAINER = `a Claude login kept in the macOS Keychain or in ~/.claude never crosses into a container; ${CLAUDE_TOKEN}`;

const CLAUDE_ON_ITS_OWN_HOME = `a Claude login kept in the macOS Keychain or in ~/.claude is not read in this sandbox, which gives Claude a home of its own; ${CLAUDE_TOKEN}`;

const CLAUDE_HOSTED = `a Claude login kept in the macOS Keychain or in ~/.claude never crosses into a hosted sandbox; ${CLAUDE_TOKEN}`;

const CODEX_IN_A_CONTAINER = 'add codex: login to the sandbox\'s credentials, the login teamai keeps apart from your daily one (create it once with `CODEX_HOME=~/.teamai/logins/codex codex login`), or an API key, OPENAI_API_KEY: env:OPENAI_API_KEY';

const CODEBUDDY = 'add CODEBUDDY_API_KEY: env:CODEBUDDY_API_KEY to the sandbox\'s credentials';

/** How each tool a step runtime launches signs in inside a sandbox, by its executable. */
export const SIGN_IN = {
  claude: {
    by: 'credentials',
    env: SIGN_INS.claude.variables,
    sbx: 'anthropic',
    gateway: SIGN_INS.claude.gateway,
    hint: {
      sbx: `sign Claude in once with sbx: run \`sbx run claude <any dir>\`, then \`/login\` in Claude Code, and every new sandbox reuses that login (an API key instead: \`sbx secret set anthropic\`); or ${CLAUDE_TOKEN}`,
      docker: CLAUDE_IN_A_CONTAINER,
      podman: CLAUDE_IN_A_CONTAINER,
      seatbelt: CLAUDE_ON_ITS_OWN_HOME,
      bwrap: CLAUDE_ON_ITS_OWN_HOME,
      vercel: CLAUDE_HOSTED,
    },
  },
  codex: {
    by: 'credentials',
    env: SIGN_INS.codex.variables,
    sbx: 'openai',
    hint: {
      sbx: 'sign Codex in once with sbx, `sbx secret set openai --oauth` (or store an API key with `sbx secret set openai`), or add OPENAI_API_KEY: env:OPENAI_API_KEY to the sandbox\'s credentials',
      docker: CODEX_IN_A_CONTAINER,
      podman: CODEX_IN_A_CONTAINER,
      seatbelt: CODEX_IN_A_CONTAINER,
      bwrap: CODEX_IN_A_CONTAINER,
      vercel: CODEX_IN_A_CONTAINER,
    },
  },
  codebuddy: { by: 'credentials', env: SIGN_INS.codebuddy.variables, hint: { sbx: CODEBUDDY, docker: CODEBUDDY, podman: CODEBUDDY, seatbelt: CODEBUDDY, bwrap: CODEBUDDY, vercel: CODEBUDDY } },
  // teamai gives OpenCode no sign-in variable, so in a sandbox it runs its free models.
  opencode: { by: 'free' },
} satisfies Record<(typeof LAUNCHABLE)[number], SignIn>;

/** How `tool` signs in inside a sandbox, when this runtime knows. */
function signInOf(tool: string): SignIn | undefined {
  return Object.entries(SIGN_IN).find(([name]) => name === tool)?.[1];
}

/** How `tool` signs in with credentials, when it does. */
function credentialsOf(tool: string): Extract<SignIn, { by: 'credentials' }> | undefined {
  const signIn = signInOf(tool);

  return signIn?.by === 'credentials' ? signIn : undefined;
}

/**
 * Whether teamai gives `tool` a sign-in: one of its variables, or a login copied into the attempt's tool home, the one
 * of `login`, the tool or instance the attempt launches (teamai copies a tool's login into no instance's home).
 */
export function isGivenSignIn(tool: string, credentials: InitCredentials, login: string = tool): boolean {
  return credentials.logins.includes(login) || credentialsOf(tool)?.env.some((name) => credentials.env.includes(name)) === true;
}

/**
 * The tools that sign in on the login sbx keeps though the member's shell points them at a gateway, by tool: the
 * variables of a sign-in of the definition's own (the gateway's and the tool's), any of which an attempt's credentials
 * carry when that login is not what signs it in, and the line that tells the member their gateway is not used there.
 */
export type UnusedGateways = Record<string, { ownSignIn: readonly string[]; notice: string }>;

/**
 * What a sandbox offers of the tools it holds: those that can sign in, why each other one cannot, those sbx keeps a
 * login for (`kept`), and the gateways that login replaces.
 */
interface SignedIn {
  tools: string[];
  unavailable: Unavailable;
  kept: string[];
  unusedGateways: UnusedGateways;
}

/**
 * Where the command an instance runs (its own, or its tool's executable) is missing in the sandbox of an attempt on
 * `tool`: what does not hold it (`holder`, such as "image ghcr.io/acme/agent:1") and how to add it there (`fix`, such
 * as "add it to the image"); undefined when the sandbox holds it.
 */
export type MissingCommand = (command: string, tool: string) => { holder: string; fix: string } | undefined;

/**
 * The tools of `tools` that can sign in on `provider`: by a credential teamai gives, or, on sbx, by the login sbx keeps
 * for its service (`stored`); each other tool is `unavailable`, with how to sign it in. An older teamai names no
 * credentials: every tool is offered, as before. `env` is the member's, which a kept login replaces a gateway of.
 *
 * Each of `instances` of a tool this runtime launches is offered under its own name too, when its tool signs in there
 * (an instance keeps its own login: teamai copies its tool's into no instance's home) and the sandbox holds its
 * `command`, or else its tool's executable (`missing`); otherwise it is `unavailable`, with why. teamai launches an offered instance's command, with its home
 * variable at the attempt's tool home.
 */
export function offerSignedIn({ tools, provider, credentials, stored, env = {}, instances, missing }: {
  tools: readonly string[];
  provider: SignInProvider;
  credentials: InitCredentials | undefined;
  stored: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
  instances: readonly InitInstance[];
  missing: MissingCommand;
}): SignedIn {
  if (credentials === undefined) return { tools: [...tools], unavailable: {}, kept: [], unusedGateways: {} };

  const isStored = (tool: string): boolean => {
    const service = credentialsOf(tool)?.sbx;

    return service !== undefined && stored.has(service);
  };

  /** Whether `tool`, launched as `login` (an instance's name), signs in here. */
  const isSignedIn = (tool: string, login = tool): boolean => signInOf(tool)?.by === 'free' || isGivenSignIn(tool, credentials, login) || isStored(tool);
  const how = (tool: string): string => credentialsOf(tool)?.hint[provider] ?? 'teamai knows no way to sign it in inside a sandbox';

  const kept = tools.filter(isStored);

  const unusedGateways = Object.fromEntries(kept.flatMap((tool) => {
    const signIn = credentialsOf(tool);
    const gateway = signIn?.gateway;

    if (signIn?.sbx === undefined || gateway === undefined || !env[gateway.url]) return [];

    return [[tool, {
      ownSignIn: [gateway.url, ...signIn.env],
      notice: `${tool} signs in here on the login sbx keeps (${signIn.sbx} in \`sbx secret ls\`), so the gateway ${gateway.url} names in your shell is not used in this sandbox. To use it there, add ${gateway.url}: env:${gateway.url} and ${gateway.token}: env:${gateway.token} to the sandbox's credentials.`,
    }]];
  }));

  const cannotSignIn = (tool: string): string => `${tool} cannot sign in inside this ${provider} sandbox, so a step there would stop at its "Not logged in": ${how(tool)}. Then start again.`;

  /**
   * Each instance of a tool this runtime launches, with why it is not offered, or undefined when it is. It runs its own
   * command, or else its tool's executable, so the sandbox need hold only that one.
   */
  const verdicts = instances.filter((instance) => signInOf(instance.tool) !== undefined).map(({ name, tool, command = tool }) => {
    if (!isSignedIn(tool, name)) {
      return { name, why: `${name}, an instance of ${tool}, cannot sign in inside this ${provider} sandbox, so a step there would stop at its "Not logged in": ${how(tool)}. Then start again.` };
    }

    const missingAt = missing(command, tool);

    return { name, why: missingAt && `${name} runs ${command}, which is not in ${missingAt.holder}: ${missingAt.fix}, or run the step with --driver local.` };
  });

  return {
    tools: [...tools.filter((tool) => isSignedIn(tool)), ...verdicts.flatMap(({ name, why }) => (why === undefined ? [name] : []))],
    kept,
    unusedGateways,
    unavailable: Object.fromEntries([
      ...tools.filter((tool) => !isSignedIn(tool)).map((tool) => [tool, fitReason(cannotSignIn(tool))]),
      ...verdicts.flatMap(({ name, why }) => (why === undefined ? [] : [[name, fitReason(why)]])),
    ]),
  };
}
