/** Expand after shell parsing so environment values remain single, literal arguments. */
export function expandEnvArgs(args: readonly string[], env: NodeJS.ProcessEnv): string[] {
  if (args[0] !== '--env-args') return [...args];

  return args.slice(1).map((arg) => {
    const name = /^@([A-Za-z_][A-Za-z0-9_]*)$/.exec(arg)?.[1];

    if (!name) return arg;

    const value = env[name];

    if (value === undefined) throw new Error(`Environment variable ${name} is not set`);

    return value;
  });
}
