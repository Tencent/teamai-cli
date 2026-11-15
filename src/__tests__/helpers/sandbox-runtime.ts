import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleRuntime } from '@teamai/runtime-testing/bundle';

const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'runtime-sandbox', 'src');

/**
 * teamai-runtime-sandbox built as it ships, on a fake `docker` and a fake `sbx` (packages/runtime-sandbox/src/testing/
 * fake-engine.mjs) whose sandboxes run on the host. `command` and `args` start it with its journal under `state`;
 * `options` choose the fake docker's one image, or the fake sbx's one agent, whose tools are the executables in `bin`.
 * `wrappers(state)` writes teamai's wrapper `teamai-sandbox-claude` for the runtime over `state` into a folder of its
 * own, and gives that folder, for the PATH of an app that runs Claude through the sandbox.
 */
export async function sandboxOnFake(provider: 'docker' | 'sbx'): Promise<{ command: string; bin: string; args: (state: string) => string[]; wrappers: (state: string) => string; options: { provider: 'docker'; image: string } | { provider: 'sbx'; agent: string } }> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sandbox-runtime-')));
  const executable = await bundleRuntime({ entry: path.join(PACKAGE, 'main.ts'), outfile: path.join(dir, 'teamai-runtime-sandbox.mjs') });

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, provider), `#!/bin/sh\nFAKE_ENGINE_NAME=${provider} exec "${process.execPath}" "${path.join(PACKAGE, 'testing', 'fake-engine.mjs')}" "$@"\n`, { mode: 0o755 });
  // The fake docker's image, or the fake sbx's agent template: either holds the tools in `bin`. The image holds node, as
  // a docker step's network filter needs to keep the step from this machine; without it the sandbox offers worktree.
  const template = provider === 'docker' ? 'scenario/agent:1' : 'claude';

  if (provider === 'docker') fs.symlinkSync(process.execPath, path.join(bin, 'node'));

  const env = (state: string): string[] => [
    `PATH=${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, `HOME=${path.join(state, 'home')}`, `FAKE_ENGINE_STATE=${path.join(state, 'engine')}`,
    `FAKE_ENGINE_IMAGES=${JSON.stringify({ [template]: bin })}`,
  ];

  return {
    command: '/usr/bin/env',
    bin,
    args: (state) => [...env(state), process.execPath, executable],
    wrappers(state) {
      const wrappers = path.join(state, 'wrappers');
      fs.mkdirSync(wrappers, { recursive: true });
      // The runtime's executable as its tool-exec entry, with the runtime's journal and engine, and the app's env beside.
      const set = env(state).map((assignment) => `'${assignment.replaceAll("'", "'\\''")}'`).join(' ');
      fs.writeFileSync(path.join(wrappers, 'teamai-sandbox-claude'), `#!/bin/sh\nexec /usr/bin/env ${set} "${process.execPath}" "${executable}" tool-exec claude "$@"\n`, { mode: 0o755 });

      return wrappers;
    },
    options: provider === 'docker' ? { provider, image: template } : { provider, agent: template },
  };
}
