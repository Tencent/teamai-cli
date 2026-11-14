import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthClientInformationFullSchema, OAuthTokensSchema, type OAuthClientInformationMixed, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import type { StepMode } from './t3.js';
import type { T3Command } from './t3-command.js';
import { readRegularFileSync } from '@teamai/shared/regular-file';

// ─── The member's sign-in to a T3 environment ───
//
//  T3's MCP endpoint takes a credential its OAuth flow issues, for a limited time, with no refresh. The runtime
//  approves its own sign-in with a pairing code the local `t3` command creates; when it cannot, the person approves it
//  in T3's page. It keeps the client registration and the token per endpoint in one file of its own, mode 0600, so a
//  later run, attended or not, reuses them:
//
//    ~/.teamai/runtime-state/t3/credentials.json
//    { "http://127.0.0.1:3773/mcp": { "client": {...}, "tokens": {...}, "expiresAt": 1793600000000 } }
//

/** How long before its end a token stops counting as valid, so a step that starts on it does not lose it mid-run. */
const EXPIRY_MARGIN_MS = 10 * 60_000;

/** How long an attended sign-in waits for the person to approve it in T3's page. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** How long the silent sign-in may take, from the `t3` command to the token, inside the 10 s an unattended init has. */
const SILENT_SIGN_IN_MS = 8_000;

/**
 * The access teamai asks T3 to approve its sign-in with: Auto, the ceiling of every mode a step runs in by default, or
 * Full access, only for a run whose `runtime_mode` is full-access.
 */
export type SignInAccess = Extract<StepMode, 'auto' | 'full-access'>;

/**
 * The scopes T3 grants a sign-in approved with each access (`mcpClientScopes` in T3's server): reading and operating
 * threads, and for Full access also writing settings and source control, which T3 requires for it.
 */
const SCOPES = {
  auto: ['orchestration:read', 'orchestration:operate'],
  'full-access': ['orchestration:read', 'orchestration:operate', 'settings:write', 'source-control:write'],
} as const satisfies Record<SignInAccess, readonly string[]>;

/**
 * Whether `tokens` serve a run that needs `access`: T3 names the scopes it granted. A token kept with none named
 * counts, since T3 itself refuses a thread broader than its grant (`sign_in_too_narrow`).
 */
function grants(tokens: OAuthTokens, access: SignInAccess): boolean {
  if (tokens.scope === undefined) return true;
  const granted = new Set(tokens.scope.split(' '));

  return SCOPES[access].every((scope) => granted.has(scope));
}

/** The name teamai registers with, which T3 lists its sign-in session under. */
const CLIENT_NAME = 'teamai workflow';

const EntrySchema = z.object({
  client: OAuthClientInformationFullSchema.optional(),
  tokens: OAuthTokensSchema.optional(),
  expiresAt: z.number().optional(),
});

const StoreSchema = z.record(z.string(), EntrySchema);

type Entry = z.infer<typeof EntrySchema>;

/** The credentials file under `stateDir`, read and written whole; a file that does not parse counts as empty. */
function credentialStore(stateDir: string) {
  const file = path.join(stateDir, 'credentials.json');

  const read = (): z.infer<typeof StoreSchema> => {
    try {
      return StoreSchema.parse(JSON.parse(readRegularFileSync(file, 'utf8')));
    } catch {
      return {};
    }
  };

  return {
    file,
    entry: (resource: string): Entry => read()[resource] ?? {},
    update(resource: string, change: (entry: Entry) => Entry): void {
      const all = read();
      all[resource] = change(all[resource] ?? {});
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(all), { mode: 0o600 });
      fs.renameSync(temp, file);
    },
  };
}

/** The token kept for `resource`, while it has more than the margin left and was granted `access`. */
export function validToken(stateDir: string, resource: string, access: SignInAccess, now = Date.now()): OAuthTokens | undefined {
  const entry = credentialStore(stateDir).entry(resource);

  return entry.tokens && (entry.expiresAt === undefined || entry.expiresAt - EXPIRY_MARGIN_MS > now) && grants(entry.tokens, access) ? entry.tokens : undefined;
}

/**
 * Which sign-in the token kept for `resource` belongs to, as a short hash of it that says nothing of the token: each
 * sign-in gets a token of its own, and T3 finds a repeated launch only under the sign-in that sent it.
 */
export function signInOf(stateDir: string, resource: string): string | undefined {
  const tokens = credentialStore(stateDir).entry(resource).tokens;

  return tokens && createHash('sha256').update(tokens.access_token).digest('hex').slice(0, 16);
}

/** The command that opens a URL in the person's browser on this platform. */
function opener(url: string): [string, string[]] {
  if (process.platform === 'darwin') return ['open', [url]];

  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '', url]];

  return ['xdg-open', [url]];
}

/**
 * The SDK's OAuth client for `resource` over the credentials file, short of sending anyone to sign in: it registers
 * teamai with `redirectUrl` once and keeps the registration, the PKCE verifier and the token the flow gets.
 */
function keptClient({ stateDir, resource, redirectUrl, access }: { stateDir: string; resource: string; redirectUrl: string; access: SignInAccess }): Omit<OAuthClientProvider, 'redirectToAuthorization'> {
  const store = credentialStore(stateDir);
  let verifier = '';

  return {
    redirectUrl,
    clientMetadata: {
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPES[access].join(' '),
    },
    clientInformation: (): OAuthClientInformationMixed | undefined => store.entry(resource).client,
    saveClientInformation: (client) => {
      const full = OAuthClientInformationFullSchema.safeParse(client);

      if (full.success) store.update(resource, (entry) => ({ ...entry, client: full.data }));
    },
    tokens: () => validToken(stateDir, resource, access),
    saveTokens: (tokens) => {
      store.update(resource, (entry) => ({ ...entry, tokens, ...(tokens.expires_in === undefined ? { expiresAt: undefined } : { expiresAt: Date.now() + tokens.expires_in * 1000 }) }));
    },
    saveCodeVerifier: (codeVerifier) => { verifier = codeVerifier; },
    codeVerifier: () => verifier,
  };
}

export interface SignIn {
  provider: OAuthClientProvider;
  /** The authorization code T3's page sends back once the person approves, after the SDK sent them there. */
  code(): Promise<string>;
  close(): void;
}

/**
 * An attended sign-in for `resource`: a loopback listener for T3's redirect, and the SDK's OAuth client over the
 * credentials file. The page opens in the person's browser; `say` also gives them its link, for a browser that does not
 * open, after why the silent sign-in could not serve the run, when it was tried.
 */
export async function attendedSignIn({ stateDir, resource, access, silentFailure, say }: { stateDir: string; resource: string; access: SignInAccess; silentFailure?: string; say(message: string): void }): Promise<SignIn> {
  let answer: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
  const answered = new Promise<string>((resolve, reject) => { answer = { resolve, reject }; });
  // A rejection nobody awaits yet must not end the process.
  answered.catch(() => {});

  const listener = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (url.pathname !== '/callback' || (!code && !error)) {
      res.writeHead(404).end();

      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(code
      ? '<!doctype html><title>teamai</title><p>teamai is signed in to T3 Code. You can close this page.</p>'
      : '<!doctype html><title>teamai</title><p>T3 Code did not sign teamai in. Close this page and start the workflow again to retry.</p>');

    if (code) answer?.resolve(code);
    else answer?.reject(new Error(`T3 Code refused the sign-in (${error}).`));
  });

  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = z.object({ port: z.number().int() }).parse(listener.address());
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => answer?.reject(new Error('Nobody approved the T3 Code sign-in within 5 minutes.')), APPROVAL_TIMEOUT_MS);

  const provider: OAuthClientProvider = {
    ...keptClient({ stateDir, resource, redirectUrl, access }),
    redirectToAuthorization: (authorizationUrl) => {
      // The person picks the access in the page: Full access only when the run asks for it.
      if (access === 'full-access') {
        say(silentFailure === undefined
          ? `Approve teamai in T3 Code with Full access, since runtime_mode is full-access, to run workflow steps as threads: ${authorizationUrl.toString()}`
          : `Approve teamai in T3 Code with Full access, since runtime_mode is full-access (silent sign-in failed: ${silentFailure}). If no browser opened, visit: ${authorizationUrl.toString()}`);
      } else {
        say(silentFailure === undefined
          ? `Approve teamai in T3 Code to run workflow steps as threads: ${authorizationUrl.toString()}`
          : `Approve teamai in T3 Code (silent sign-in failed: ${silentFailure}). If no browser opened, visit: ${authorizationUrl.toString()}`);
      }

      const [command, args] = opener(authorizationUrl.toString());
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
    },
  };

  return {
    provider,
    code: () => answered,
    close: () => {
      clearTimeout(timer);
      listener.close();
    },
  };
}

/** What the `t3` command prints for a pairing code it created; the code itself is `credential`. */
const PairingSchema = z.object({ credential: z.string().min(1) });

/** T3's answer to a sign-in decision: the redirect that carries the authorization code. */
const DecisionSchema = z.object({ redirectTo: z.url() });

/** The fields of an authorization request T3's decision endpoint reads, as the SDK put them in the sign-in page's address. */
const AUTHORIZATION_FIELDS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'resource'] as const;

/** Creates a pairing code with the local `t3` command for the T3 server whose data directory is `t3Home`; never says the code. */
async function createPairingCode({ t3Cli, t3Home, access, signal }: { t3Cli: T3Command; t3Home: string; access: SignInAccess; signal: AbortSignal }): Promise<string> {
  const args = ['auth', 'pairing', 'create', '--json', '--base-dir', t3Home, ...SCOPES[access].flatMap((scope) => ['--scope', scope]), '--ttl', '2m', '--label', CLIENT_NAME];
  const stdout = await t3Cli.run({ name: 'auth pairing create', args, signal });

  try {
    return PairingSchema.parse(JSON.parse(stdout)).credential;
  } catch {
    throw new Error('t3 auth pairing create printed no pairing code');
  }
}

/**
 * Approves the sign-in the SDK built `authorizationUrl` for with a pairing code, as T3's page posts it, and returns the
 * authorization code T3 redirects with. The access is Auto whatever a tighter runtime_mode: a tighter mode needs the
 * same scopes, each thread still runs in its own mode, and the grant is only their ceiling. One credential then serves
 * every run, and a run at a tighter mode never leaves a sign-in too narrow for a later Auto run. Only a full-access run
 * asks for Full access, which also serves every later run.
 */
async function approveWithPairingCode(authorizationUrl: URL, { t3Cli, t3Home, access, signal }: { t3Cli: T3Command; t3Home: string; access: SignInAccess; signal: AbortSignal }): Promise<string> {
  const code = await createPairingCode({ t3Cli, t3Home, access, signal });

  const authorization = Object.fromEntries(AUTHORIZATION_FIELDS.flatMap((field) => {
    const value = authorizationUrl.searchParams.get(field);

    return value === null ? [] : [[field, value]];
  }));

  const reply = await fetch(new URL('decision', authorizationUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorization, decision: { _tag: 'pairing-code', access, code } }),
    signal,
  });

  const body: unknown = await reply.json().catch(() => undefined);

  if (!reply.ok) {
    const said = z.object({ message: z.string() }).safeParse(body);

    throw new Error(`T3 Code refused the pairing code with HTTP ${reply.status}${said.success ? `: ${said.data.message.replace(/\.$/, '')}` : ''}`);
  }

  const decided = DecisionSchema.safeParse(body);

  if (!decided.success) throw new Error('T3 Code answered the sign-in decision with no redirect');
  const redirect = new URL(decided.data.redirectTo);
  const authorizationCode = redirect.searchParams.get('code');

  if (!authorizationCode) throw new Error(`T3 Code's sign-in redirect carried no code${redirect.searchParams.has('error') ? ` (${redirect.searchParams.get('error') ?? ''})` : ''}`);

  return authorizationCode;
}

export type SilentSignIn = { ok: true } | { ok: false; reason: string };

/**
 * Signs teamai in to `resource` with no page and no question: the `t3` command on this machine creates a pairing code
 * for the T3 server whose data directory is `t3Home`, and teamai approves its own authorization request with it, with
 * `access`. The SDK's flow registers the client and holds the PKCE verifier, and keeps the token in the credentials
 * file. A failure says why, in a few words, and names no code or token.
 */
export async function signInSilently({ stateDir, resource, t3Home, t3Cli, access }: { stateDir: string; resource: URL; t3Home: string; t3Cli: T3Command; access: SignInAccess }): Promise<SilentSignIn> {
  // One deadline over every step, so a T3 Code that stops answering ends the attempt with a reason rather than holding init.
  const signal = AbortSignal.timeout(SILENT_SIGN_IN_MS);
  const fetchFn = (url: string | URL, init?: RequestInit): Promise<Response> => fetch(url, { ...init, signal });
  let authorizationCode: string | undefined;

  // T3 accepts a loopback redirect on any port, and nobody follows this one: the decision hands the code back.
  const provider: OAuthClientProvider = {
    ...keptClient({ stateDir, resource: resource.href, redirectUrl: 'http://127.0.0.1/callback', access }),
    redirectToAuthorization: async (authorizationUrl) => { authorizationCode = await approveWithPairingCode(authorizationUrl, { t3Cli, t3Home, access, signal }); },
  };

  try {
    await auth(provider, { serverUrl: resource, scope: SCOPES[access].join(' '), fetchFn });

    if (authorizationCode === undefined) return { ok: false, reason: 'T3 Code started no sign-in' };
    await auth(provider, { serverUrl: resource, scope: SCOPES[access].join(' '), authorizationCode, fetchFn });

    return validToken(stateDir, resource.href, access) ? { ok: true } : { ok: false, reason: 'T3 Code issued no credential' };
  } catch (error) {
    if (signal.aborted) return { ok: false, reason: `the silent sign-in did not finish within ${SILENT_SIGN_IN_MS / 1_000} s` };

    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** An unattended client: the kept token or nothing, and no sign-in, since nobody is there to approve one. */
export function unattendedAuth(stateDir: string, resource: string, access: SignInAccess): OAuthClientProvider {
  return {
    redirectUrl: undefined,
    clientMetadata: { client_name: CLIENT_NAME, redirect_uris: [] },
    clientInformation: () => credentialStore(stateDir).entry(resource).client,
    tokens: () => validToken(stateDir, resource, access),
    saveTokens: () => {},
    redirectToAuthorization: () => { throw new Error('An unattended run cannot sign in to T3 Code.'); },
    saveCodeVerifier: () => {},
    codeVerifier: () => '',
  };
}
