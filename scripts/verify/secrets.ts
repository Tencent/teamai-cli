/**
 * Keys in a world, by name only: what `--pass` copies from the harness's environment into one command's, and the
 * redaction that keeps every passed value, and every secret-looking value of the harness, out of the terminal and logs/.
 */
import { JsonObjectSchema, type JsonValue } from '@teamai/shared/json';
import { collectEnvSecrets, MIN_ENV_VALUE_LENGTH, redact } from '@teamai/shared/redact';

const VARIABLE_NAME = /^[A-Za-z_]\w*$/;

/** `--pass NAME[,NAME…]` or `--pass=NAME[,NAME…]` at the head of a verb's command, split from the command it precedes. */
export function splitPassOption(argv: readonly string[]) {
  const [first = '', second = ''] = argv;
  const [value, rest] = first === '--pass' ? [second, argv.slice(2)] : first.startsWith('--pass=') ? [first.slice('--pass='.length), argv.slice(1)] : [undefined, [...argv]];

  return { names: value === undefined ? [] : value.split(',').filter(Boolean), argv: rest };
}

/** The named variables of `env`, or the names it has no value for (a name that is no variable's has none). */
export function passedKeys(names: readonly string[], env: NodeJS.ProcessEnv): { ok: true; keys: Map<string, string> } | { ok: false; missing: string[] } {
  const missing = names.filter((name) => !VARIABLE_NAME.test(name) || !env[name]);

  if (missing.length > 0) return { ok: false, missing };

  return { ok: true, keys: new Map(names.map((name) => [name, env[name] ?? ''])) };
}

/** Masks each passed value, whatever its name, and each secret-looking value of the harness's own environment, by name. */
export function worldRedactor({ passed, harnessEnv }: { passed: ReadonlyMap<string, string>; harnessEnv: NodeJS.ProcessEnv }): (text: string) => string {
  const envSecrets = { ...collectEnvSecrets(harnessEnv), ...Object.fromEntries(passed) };

  return (text) => redact(text, { envSecrets, patterns: false });
}

/**
 * How the ledger masks what it writes of a world: as its commands' output was, each name they were given with --pass
 * (`passedNames`) by the value it has in the harness now; `unmasked` names those the harness does not set, whose values
 * it cannot mask.
 */
export function ledgerRedactor({ passedNames, harnessEnv }: { passedNames: readonly string[]; harnessEnv: NodeJS.ProcessEnv }) {
  const passed = new Map(passedNames.flatMap((name) => (harnessEnv[name] ? [[name, harnessEnv[name]] as const] : [])));

  return { mask: worldRedactor({ passed, harnessEnv }), unmasked: passedNames.filter((name) => !passed.has(name)) };
}

/** Feeds output through `mask` a whole line at a time, so a value split across two chunks is still masked. */
export function lineRedactor(mask: (text: string) => string) {
  let pending = '';

  return {
    push(chunk: string): string {
      const lines = `${pending}${chunk}`;
      const end = lines.lastIndexOf('\n') + 1;
      pending = lines.slice(end);

      return mask(lines.slice(0, end));
    },
    end(): string {
      const rest = pending;
      pending = '';

      return mask(rest);
    },
  };
}

/** A process's environment as /proc/<pid>/environ holds it: NUL-separated NAME=value, read in memory only. */
export function parseEnviron(text: string): Map<string, string> {
  return new Map(text.split('\0').flatMap((pair) => {
    const at = pair.indexOf('=');

    return at > 0 ? [[pair.slice(0, at), pair.slice(at + 1)] as const] : [];
  }));
}

/**
 * The names of every `credentials` mapping in `document`, a parsed driver definition or a member's settings: a runtime
 * entry's `options.credentials`, or `workflows.drivers.<name>.runtimes.<use>.credentials`.
 */
export function declaredCredentialNames(document: JsonValue): string[] {
  if (Array.isArray(document)) return document.flatMap(declaredCredentialNames);
  const mapping = JsonObjectSchema.safeParse(document);

  if (!mapping.success) return [];

  return Object.entries(mapping.data).flatMap(([key, value]) => {
    if (key !== 'credentials') return declaredCredentialNames(value);
    const credentials = JsonObjectSchema.safeParse(value);

    return credentials.success ? Object.keys(credentials.data) : [];
  });
}

/** Whether a sandbox's environment is what a step may carry, or the names of the variables that leak: names only, never a value. */
export type EnvVerdict = { kind: 'ok' } | { kind: 'leak'; names: string[] };

/**
 * Judges `env`, a sandbox's environment: a variable leaks when it holds the world's canary, which no step may receive, or
 * the value of a host secret (`secrets`) under a name the step's credentials did not declare. A value holds a secret
 * where `redact` would mask it there; one shorter than redact's own minimum only under the secret's name, since under
 * another a variable such as SHLVL=1 holds it by chance.
 */
export function judgeSandboxEnv({ env, canary, secrets, declared }: { env: ReadonlyMap<string, string>; canary: string; secrets: ReadonlyMap<string, string>; declared: ReadonlySet<string> }): EnvVerdict {
  const envSecrets = Object.fromEntries([...secrets].filter(([, value]) => value.length >= MIN_ENV_VALUE_LENGTH));

  const holdsSecret = (name: string, value: string): boolean => {
    const own = secrets.get(name);

    return redact(value, { envSecrets, patterns: false }) !== value || (own === value && value.length < MIN_ENV_VALUE_LENGTH);
  };

  const names = [...env].flatMap(([name, value]) => {
    if (canary !== '' && value.includes(canary)) return [name];

    return !declared.has(name) && holdsSecret(name, value) ? [name] : [];
  });

  return names.length === 0 ? { kind: 'ok' } : { kind: 'leak', names: names.toSorted() };
}
