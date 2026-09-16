import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { MAX_SOURCE_BYTES, sha256, type SourceInput, type SourceSnapshot } from './schema.js';

const execFileAsync = promisify(execFile);

/** Read only committed Git objects. Never resolve a source through the working tree. */
export async function readGitSource(source: SourceInput, manifestDirectory: string): Promise<SourceSnapshot> {
  const fail = (reason: string): never => { throw new Error(`Source ${source.source_id}: ${reason}`); };
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit)) fail('a full commit SHA is required.');
  const segments = source.path.split('/');
  if (path.posix.isAbsolute(source.path) || /^[A-Za-z]:/.test(source.path) || /[\\\x00-\x1f\x7f]/.test(source.path) ||
      segments.some(segment => !segment || segment === '.' || segment === '..')) {
    fail('the source path must be a safe relative Git path.');
  }
  const repo = path.resolve(manifestDirectory, source.repo);
  // Inherited Git routing/configuration must not change the requested local repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '',
  });
  const git = async (args: string[], maxBuffer = 16 * 1024): Promise<Buffer> => {
    try {
      const { stdout } = await execFileAsync('git', [
        '--no-replace-objects', '--literal-pathspecs', '-C', repo,
        '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args,
      ], { encoding: 'buffer', maxBuffer, timeout: 10_000, env });
      return stdout;
    } catch {
      // Child-process errors include the command and repository path; never relay them.
      return fail('the requested committed object could not be read locally.');
    }
  };

  if ((await git(['cat-file', '-t', source.commit])).toString('utf8').trim() !== 'commit') {
    fail('the source version must identify a commit object.');
  }
  let tree = source.commit;
  let blob = '';
  for (let index = 0; index < segments.length; index++) {
    const entry = (await git(['ls-tree', '-z', tree, '--', segments[index]])).toString('utf8');
    const entries = entry.split('\0').filter(Boolean);
    if (entries.length !== 1) fail('the source path is not present in the commit.');
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]*)$/.exec(entries[0]);
    if (!match || match[4] !== segments[index]) fail('the source tree entry is invalid.');
    const [, mode, type, oid] = match!;
    if (mode === '120000') fail('symbolic links are not supported.');
    if (mode === '160000' || type === 'commit') fail('submodules are not supported.');
    if (index < segments.length - 1) {
      if (mode !== '040000' || type !== 'tree') fail('a source path parent is not a directory.');
      tree = oid;
    } else {
      if (!['100644', '100755'].includes(mode) || type !== 'blob') fail('the source must be a regular file.');
      blob = oid;
    }
  }
  const size = Number((await git(['cat-file', '-s', blob])).toString('utf8').trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SOURCE_BYTES) fail('the source file is too large.');
  const bytes = await git(['cat-file', 'blob', blob], MAX_SOURCE_BYTES + 1);
  if (bytes.length !== size) fail('the committed blob size changed.');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail('binary or invalid UTF-8 source files are not supported.');
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) fail('binary source files are not supported.');
  return {
    source_id: source.source_id, source_version: source.commit, path: source.path, kind: source.kind,
    content, content_hash: sha256(content), policy_ref: source.policy_ref,
  };
}
