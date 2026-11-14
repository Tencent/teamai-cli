import type { HostRoute } from './provider.js';

// ─── A credential that points at this machine itself ───
//
//  A URL credential on this machine itself, such as a model gateway on localhost, would mean the sandbox's own loopback
//  inside one. Where the provider gives this machine a name inside its sandboxes, the URL's host becomes that name, its
//  scheme, port and path kept:
//
//    ANTHROPIC_BASE_URL=http://127.0.0.1:8317/anthropic   →   http://host.docker.internal:8317/anthropic   Docker Desktop, sbx
//                                                         →   http://host.containers.internal:8317/…     Podman
//
//  Where it gives none (Docker on Linux), the credential is refused, naming the variable, never the value.
//

/**
 * Whether `hostname`, as a URL spells it, is this machine itself: localhost, 127.0.0.0/8, ::1 (also IPv4-mapped), or
 * the unspecified 0.0.0.0 and ::, which a client connects to as this machine.
 */
function isThisMachine(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '');

  return host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0'
    || ['[::1]', '[::]'].includes(host) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

/** The URL `value` names, when it is one on this machine itself. */
function localUrl(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);

  return isThisMachine(url.hostname) ? url : undefined;
}

/** A credential whose value is a URL on this machine itself, with the port it reaches there. */
export interface OnThisMachine {
  name: string;
  port: number;
}

/** The credentials whose value is a URL on this machine itself, each with its port. */
export function onThisMachine(credentials: Record<string, string>): OnThisMachine[] {
  return Object.entries(credentials).flatMap(([name, value]) => {
    const url = localUrl(value);

    if (url === undefined) return [];

    return [{ name, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }];
  });
}

/** The scheme and user info, the host as written, and the rest of a URL. */
const AUTHORITY = /^([a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?)(\[[^\]]*\]|[^:/?#]*)(.*)$/is;

/**
 * `credentials` with each URL on this machine itself pointed at `alias`. Only the host changes, as the value spells
 * it, so a URL that ends without a path still does.
 */
export function toAlias(credentials: Record<string, string>, alias: string): Record<string, string> {
  return Object.fromEntries(Object.entries(credentials).map(([name, value]) => {
    const parts = localUrl(value) === undefined ? null : AUTHORITY.exec(value);

    return [name, parts === null ? value : `${parts[1]}${alias}${parts[3]}`];
  }));
}

/**
 * Each credential value the sandbox got in place of the one teamai gave, so it is masked as that one: teamai masks only
 * the values it gave, which a rewritten value no longer spells.
 */
export function rewrittenMasks(given: Record<string, string>, sent: Record<string, string>) {
  return Object.fromEntries(Object.entries(sent).filter(([name, value]) => given[name] !== value).map(([name, value]) => [`${name} (in the sandbox)`, value]));
}

/** What masks the credentials a process got: each value teamai gave, and each as the sandbox got it. */
export function maskedAsGiven(given: Record<string, string>, sent: Record<string, string>) {
  return { ...given, ...rewrittenMasks(given, sent) };
}

/** `credentials` as a sandbox gets them: a URL on this machine itself at the name `host` gives it there. */
export function inSandbox(credentials: Record<string, string>, host: HostRoute): Record<string, string> {
  return host.ok ? toAlias(credentials, host.alias) : credentials;
}
