import module from 'node:module';
import { fileURLToPath } from 'node:url';
import { runHookFastPath, runLoginDeferredHook } from './hook-fast-path.js';

// A hook whose command deferred the login shell is answered here in every case (#1788).
const deferred = await runLoginDeferredHook(process.argv.slice(2), { env: process.env, platform: process.platform, stdin: () => process.stdin });

if (deferred !== null) process.exit(deferred);

// A hook whose handlers all run in the background exits here, before the CLI
// bundle loads: loading it was most of what a tool call kept the agent
// waiting for (#1788). Anything else falls through to the CLI.
const hook = await runHookFastPath(process.argv.slice(2), {
  env: process.env,
  platform: process.platform,
  stdin: () => process.stdin,
  entry: fileURLToPath(import.meta.url),
});

if (hook === 'done') process.exit(0);

// The executable npm links as `teamai` (dist/index.js). Node 22.1+ keeps V8's
// compiled code of the modules loaded after this call, so a later run skips
// compiling the CLI bundle: about a fifth of a short command's time, paid by
// every hook an agent runs. The CLI is therefore its own file (see
// tsup.config.ts), loaded after the call by URL, so the bundler leaves it out
// of this one. Node 20 has no compile cache.
// SAFETY: Node 22.1+ defines module.enableCompileCache and the @types/node 20 the build pins does not,
// so it is typed optional and called only where it exists.
(module as typeof module & { enableCompileCache?: () => void }).enableCompileCache?.();

// oxlint-disable-next-line teamai/package-boundaries -- the CLI bundle beside this file, by URL so tsup leaves it out
await import(new URL('./cli.js', import.meta.url).href);
