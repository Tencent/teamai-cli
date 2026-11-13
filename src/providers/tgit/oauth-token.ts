import fs from 'node:fs';
import path from 'node:path';
import { getUserHome, legacyUserHome } from '@teamai/shared/home';
import { readRegularFileSync } from '@teamai/shared/regular-file';

/**
 * Retrieve the OAuth token that gf stored in ~/.netrc.
 *
 * gf CLI uses the netrc-parser library to persist tokens.  The entry
 * for git.woa.com looks like:
 *   machine git.woa.com login <user> password <token> ...
 *
 * We parse the file directly instead of relying on `git credential fill`,
 * which depends on a working git credential helper and may trigger
 * interactive password prompts.
 *
 * Returns null if no credential is found.
 */
export function gfGetOAuthToken(): string | null {
  // `gf` wrote this file when `~` still resolved to `os.homedir()`, so a user
  // whose HOME points elsewhere keeps working after the upgrade: read the
  // current location first, then the legacy one.
  let candidates: string[];

  try {
    candidates = [path.join(getUserHome(), '.netrc')];
    const legacy = legacyUserHome();

    if (legacy) candidates.push(path.join(legacy, '.netrc'));
  } catch {
    return null;
  }

  for (const netrcPath of candidates) {
    try {
      // `existsSync` first, as this reader has always done: it keeps the
      // "no ~/.netrc" case a cheap no-op rather than a thrown ENOENT. A file
      // that exists but cannot be read still falls through to the next
      // candidate via the `catch`.
      if (!fs.existsSync(netrcPath)) continue;
      const content = readRegularFileSync(netrcPath, 'utf-8');

      // Match: machine git.woa.com ... password <TOKEN>
      const match = content.match(
        /machine\s+git\.woa\.com\s+.*?password\s+(\S+)/,
      );

      if (match?.[1]) return match[1];
    } catch {
      // Missing or unreadable here — try the next location.
    }
  }

  return null;
}
