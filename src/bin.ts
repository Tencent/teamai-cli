import module from 'node:module';

// The executable npm links as `teamai` (dist/index.js). Node 22.1+ keeps V8's
// compiled code of the modules loaded after this call, so a later run skips
// compiling the CLI bundle: about a fifth of a short command's time, paid by
// every hook an agent runs. The CLI is therefore its own file (see
// tsup.config.ts), loaded after the call by URL, so the bundler leaves it out
// of this one. Node 20 has no compile cache.
(module as typeof module & { enableCompileCache?: () => unknown }).enableCompileCache?.();
await import(new URL('./cli.js', import.meta.url).href);
