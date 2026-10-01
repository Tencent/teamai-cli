import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { DRY_RUN_PREVIEW, NO_DRY_RUN_PREVIEW, dryRunRefusal } from '../dry-run-guard.js';

/**
 * Every command path that runs an action. A group without its own action
 * (`hooks`, `mcp`, ...) only prints help, so it never reaches the guard.
 * Commander keeps the action private, so the walk reads `_actionHandler`.
 */
function runnablePaths(command: Command, prefix: string[] = []): string[] {
  return command.commands.flatMap((sub) => {
    const path = [...prefix, sub.name()];
    const own = (sub as unknown as { _actionHandler: unknown })._actionHandler ? [path.join(' ')] : [];
    return [...own, ...runnablePaths(sub, path)];
  });
}

async function commandTable(): Promise<Command> {
  vi.stubEnv('TEAMAI_COMMAND_TABLE_ONLY', '1');
  return (await import('../index.js')).program;
}

describe('--dry-run guard classification', () => {
  it('classifies every command: a new command must say whether it previews --dry-run', async () => {
    const unclassified = runnablePaths(await commandTable())
      .filter((path) => !DRY_RUN_PREVIEW.has(path) && !(path in NO_DRY_RUN_PREVIEW));
    // Add the path to DRY_RUN_PREVIEW when its action honors --dry-run or only
    // reads; otherwise to NO_DRY_RUN_PREVIEW, which refuses it (#900).
    expect(unclassified).toEqual([]);
  });

  it('lists no command twice and none that no longer exists', async () => {
    const paths = new Set(runnablePaths(await commandTable()));
    const refused = Object.keys(NO_DRY_RUN_PREVIEW);
    expect(refused.filter((path) => DRY_RUN_PREVIEW.has(path))).toEqual([]);
    expect([...DRY_RUN_PREVIEW, ...refused].filter((path) => !paths.has(path))).toEqual([]);
  });
});

describe('--dry-run guard decisions', () => {
  function command(path: string, args: string[] = []): Command {
    let current = new Command('teamai');
    for (const name of path.split(' ')) current = current.command(name);
    if (path === 'ci extract-mr') current.option('--output <dir>');
    if (path === 'import') {
      current.option('--from-org <org>').option('--from-repo <url>').option('--from-repo-list <yaml>')
        .option('--from-iwiki <id>').option('--from-mr <url>').option('--dir <path>').option('--from-claude');
    }
    current.parse(args, { from: 'user' });
    return current;
  }

  it.each([
    'digest',
  ])('refuses %s until its writes have a preview', (path) => {
    expect(dryRunRefusal(command(path))).toBe(`teamai ${path} has no --dry-run preview, nothing was run`);
  });

  it.each(['stats', 'recall'])('allows the merged %s preview', (path) => {
    expect(dryRunRefusal(command(path))).toBeUndefined();
  });

  it('allows the hooks injection preview', () => {
    expect(DRY_RUN_PREVIEW.has('hooks inject')).toBe(true);
    expect(NO_DRY_RUN_PREVIEW).not.toHaveProperty('hooks inject');
    expect(dryRunRefusal(command('hooks inject'))).toBeUndefined();
  });

  it('allows the update preview', () => {
    expect(DRY_RUN_PREVIEW.has('update')).toBe(true);
    expect(NO_DRY_RUN_PREVIEW).not.toHaveProperty('update');
    expect(dryRunRefusal(command('update'))).toBeUndefined();
  });

  it.each([
    'remove', 'roles init', 'roles add', 'roles remove', 'roles update',
    'projects add', 'projects update', 'projects remove',
  ])('restores the git preview for %s', (path) => {
    expect(dryRunRefusal(command(path))).toBeUndefined();
  });

  it.each(['--from-iwiki', '--from-claude'])('refuses import %s', (flag) => {
    const args = flag === '--from-claude' ? [flag] : [flag, 'source'];
    expect(dryRunRefusal(command('import', args))).toBe(`teamai import ${flag} has no --dry-run preview, nothing was run`);
  });

  it.each([
    [], ['--from-org', 'team'], ['--from-mr', 'url'], ['--dir', '.'],
    ['--from-repo', 'url'], ['--from-repo-list', 'list'],
    ['--from-repo', 'url', '--from-iwiki', 'page', '--from-claude'],
    ['--from-repo-list', 'list', '--from-iwiki', 'page', '--from-claude'],
    ['--from-org', 'team', '--from-repo', 'url', '--from-repo-list', 'list', '--from-iwiki', 'page', '--from-claude'],
    ['--from-org', 'team', '--from-repo', 'url'],
    ['--from-mr', 'url', '--from-claude'], ['--dir', '.', '--from-claude'],
  ].map((args) => [args]))('preserves safe import source precedence for %j', (args) => {
    expect(dryRunRefusal(command('import', args))).toBeUndefined();
  });

  it('refuses iWiki when it takes precedence over MR', () => {
    expect(dryRunRefusal(command('import', ['--from-iwiki', 'page', '--from-mr', 'url'])))
      .toBe('teamai import --from-iwiki has no --dry-run preview, nothing was run');
  });

  it('refuses CI artifact output but preserves the no-output preview', () => {
    expect(dryRunRefusal(command('ci extract-mr', ['--output', 'out'])))
      .toBe('teamai ci extract-mr --output has no --dry-run preview, nothing was run');
    expect(dryRunRefusal(command('ci extract-mr'))).toBeUndefined();
  });

  it.each(['stats', 'recall'])('allows the merged %s preview', (path) => {
    expect(dryRunRefusal(command(path))).toBeUndefined();
  });

  it('keeps the merged feedback preview reachable independently of recall queries', () => {
    expect(dryRunRefusal(command('recall feedback'))).toBeUndefined();
  });
});
