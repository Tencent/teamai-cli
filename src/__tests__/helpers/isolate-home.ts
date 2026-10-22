import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Commands resolve ~/.teamai (config, state, the sync lock) from HOME at call
// time. A test that reaches the real home shares that state with every teamai
// session on the machine, so a live session's lock made push() tests fail
// (#924). Give each test file, and the CLIs it spawns, its own empty home.
// A test that stubs HOME itself still wins, and unstubbing restores this one.
// Long path, like other temp roots (#870): Windows can hand out a short
// 8.3 tmpdir that paths resolved later would not match.
const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-test-home-')));
process.env.HOME = home;
process.env.USERPROFILE = home;
// The temporary directory too: teamai keeps git answers there between runs
// (src/utils/git-answers.ts), and tests must neither share them nor fill the
// file the real CLI reads. Spelled as os.tmpdir() was, not resolved like home.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-test-tmp-'));
process.env.TMPDIR = tmp;
process.env.TMP = tmp;
process.env.TEMP = tmp;

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});
