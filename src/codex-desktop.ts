import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * The Codex binaries the desktop app ships (#1244): the macOS bundles, and on
 * Windows the most recently modified `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`,
 * since an update leaves the previous bundle behind.
 */
export function desktopCodexBinaries(): string[] {
  const macOS = [
    path.join('/Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'),
    path.join('/Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
    path.join(homedir(), 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'),
    path.join(homedir(), 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
    path.join('/Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
  ];
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return macOS;
  const bin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  let bundles: string[];
  try { bundles = readdirSync(bin); } catch { return macOS; }
  const newest = bundles
    .map((bundle) => path.join(bin, bundle, 'codex.exe'))
    .flatMap((exe) => {
      try { return [{ exe, mtimeMs: statSync(exe).mtimeMs }]; } catch { return []; }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return newest ? [...macOS, newest.exe] : macOS;
}
