import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { bundleRuntime } from '@teamai/runtime-testing/bundle';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGE = path.join(ROOT, 'packages', 'runtime-paseo', 'src');

/**
 * teamai-runtime-paseo bundled into one file as it ships, and a fake Paseo daemon (packages/runtime-paseo/src/testing/fake-daemon.ts)
 * running as its own process for the test file, which it outlives only until its stdin closes. `behave` sets how the
 * daemon's next agents behave; `args` start the runtime with its journal under `state`. `forget(op)` deletes the agent
 * the create of prompt `op` started, as the person deletes it in the Paseo app.
 */
export async function paseoOnFakeDaemon(): Promise<{ url: string; args: (state: string) => string[]; behave: (behaviour: Record<string, unknown>) => void; forget: (op: string) => void }> {
  const bundles = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-paseo-runtime-'));
  const [runtime, daemon] = await Promise.all([
    bundleRuntime({ entry: path.join(PACKAGE, 'main.ts'), outfile: path.join(bundles, 'teamai-runtime-paseo.mjs') }),
    bundleRuntime({ entry: path.join(PACKAGE, 'testing', 'fake-daemon.ts'), outfile: path.join(bundles, 'fake-daemon.mjs') }),
  ]);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fake-paseo-'));
  const child = spawn(process.execPath, [daemon, '--state', state], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.unref();
  process.once('exit', () => {
    child.kill('SIGKILL');
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(bundles, { recursive: true, force: true });
  });
  const [line] = await Promise.race([
    readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]().next().then((next) => [next.value]),
    new Promise<never>((_, reject) => child.once('exit', (code) => reject(new Error(`the fake Paseo daemon exited with ${code}`)))),
  ]);
  const { url } = JSON.parse(String(line)) as { url: string };

  return {
    url,
    // The runtime loads the client the member's Paseo installed; here, the one installed for the tests.
    args: (home) => [`HOME=${path.join(home, 'home')}`, `PASEO_CLIENT_PATH=${path.join(ROOT, 'node_modules', '@getpaseo', 'client')}`, process.execPath, runtime],
    behave: (behaviour) => fs.writeFileSync(path.join(state, 'behaviour.json'), JSON.stringify(behaviour)),
    forget(op) {
      const file = path.join(state, 'behaviour.json');
      const behaviour = z.record(z.string(), z.unknown()).parse(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
      const forgotten = z.array(z.string()).catch([]).parse(behaviour['forget_creates']);

      fs.writeFileSync(file, JSON.stringify({ ...behaviour, forget_creates: [...forgotten, op] }));
    },
  };
}
