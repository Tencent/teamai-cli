import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { restartDaemon, dir, daemon, behave, start, ready, useRuntimeSuite } from '../testing/suite.js';

describe('teamai-runtime-paseo', () => {
  useRuntimeSuite();

  describe('the daemon, as Paseo\'s own config names it', () => {
    /** Writes Paseo's config in `home`, as `paseo daemon config` keeps it, with the daemon listening at `listen`. */
    const paseoConfig = (home: string, listen: string): void => {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, daemon: { listen, relay: { enabled: false } } }));
    };

    it('connects to the daemon `daemon.listen` names in $PASEO_HOME/config.json when the definition sets no url, and a url set overrides it', async () => {
      // The fake offers Claude alone, so an init that reached any other daemon, such as one on Paseo's default port, differs.
      behave({ models: { claude: ['claude-opus-5-5'] } });
      const home = path.join(dir, 'paseo-home');
      paseoConfig(home, `127.0.0.1:${new URL(daemon.url).port}`);

      expect(await ready(start({ PASEO_HOME: home }), { options: {} })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude'] } });

      paseoConfig(home, '127.0.0.1:1');
      expect(await ready(start({ PASEO_HOME: home }), { options: { url: daemon.url } })).toMatchObject({ type: 'init', ok: true });
    });

    it('reads ~/.paseo/config.json when PASEO_HOME is unset, where a listen of a port alone is that port on 127.0.0.1', async () => {
      behave({ models: { claude: ['claude-opus-5-5'] } });
      paseoConfig(path.join(dir, 'home', '.paseo'), new URL(daemon.url).port);

      expect(await ready(start({ PASEO_HOME: undefined }), { options: {} })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude'] } });
    });

    it('reaches a daemon Paseo\'s config puts on a Unix socket, and takes it as one on this machine', async () => {
      await daemon.close();
      // A Unix socket's path is at most 104 bytes on macOS, which the test directory may pass.
      const sockets = fs.mkdtempSync(path.join('/tmp', 'tpaseo-'));
      onTestFinished(() => fs.rmSync(sockets, { recursive: true, force: true }));
      const socket = path.join(sockets, 'd.sock');
      await restartDaemon({ port: 0, socket });
      behave({ codex_login: 'signed_in' });
      const home = path.join(dir, 'paseo-home');
      paseoConfig(home, socket);

      // Codex's sign-in is checked only on a daemon on this machine, which a Unix socket is.
      expect(await ready(start({ PASEO_HOME: home }), { options: {} })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude', 'codex', 'opencode'] } });
    });

    it('fails init naming Paseo\'s config when it cannot read the daemon\'s address there, rather than guess one', async () => {
      const home = path.join(dir, 'paseo-home');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, 'config.json'), '{"daemon": {"listen": ');

      expect(await ready(start({ PASEO_HOME: home }), { options: {} })).toMatchObject({
        type: 'init', ok: false,
        error: { code: 'paseo_config', message: expect.stringContaining(`teamai-runtime-paseo could not read the Paseo daemon's address from ${path.join(home, 'config.json')}`) },
      });
    });
  });
});
