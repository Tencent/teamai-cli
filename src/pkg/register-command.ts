import type { Command } from 'commander';
import type { GlobalOptions } from '../types.js';

// Options shared by the `packages` parent (default action) and its `install`
// subcommand, so `teamai packages` and `teamai packages install` both accept
// the same flags.
function addInstallOptions(cmd: Command): Command {
  return cmd
    .option('-g, --global', 'Install an npm target globally (for CLI tools)')
    .option('--registry <url>', 'Use a specific npm registry for this target')
    .option('--npm', 'Treat an ambiguous target as an npm package')
    .option('--claude', 'Treat the target as a Claude plugin');
}

/**
 * Register the `packages` command (with its `install` subcommand) on `program`.
 * Exported so tests can drive the real command wiring through commander's parser.
 *
 * `run` defaults to the real `pkgInstall`; tests inject a spy to assert exactly
 * which options reach it. Each action resolves options via optsWithGlobals(),
 * which merges the command's own options with every ancestor's — so install
 * options declared on the `packages` parent (--global, --registry, --npm,
 * --claude) are still passed when invoked via `packages install`, not only the
 * root global options such as --dry-run.
 */
export function registerPackagesCommand(
  program: Command,
  run: (target: string | undefined, opts: GlobalOptions) => Promise<void> = async (
    target,
    opts,
  ) => {
    const { pkgInstall } = await import('./commands.js');
    await pkgInstall(target, opts);
  },
): Command {
  const invoke = (target: string | undefined, command: Command) =>
    run(target, command.optsWithGlobals<GlobalOptions>());

  const packagesCmd = addInstallOptions(
    program
      .command('packages [target]')
      .description('Install team npm packages and Claude plugins declared in teamai.yaml'),
  ).action(async (target: string | undefined, _opts, command: Command) => {
    // Default action: install (equivalent to `teamai packages install`).
    await invoke(target, command);
  });

  addInstallOptions(
    packagesCmd
      .command('install [target]')
      .description('Install team npm packages and Claude plugins declared in teamai.yaml'),
  ).action(async (target: string | undefined, _opts, command: Command) => {
    await invoke(target, command);
  });

  return packagesCmd;
}
