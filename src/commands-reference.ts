import type { Command, Option } from 'commander';

// ─── Generated command reference ─────────────────────────
//
//  The `core` skill used to carry a hand-written cheat sheet
//  labelled "ground truth". It drifted four times (e151d43,
//  1ca43ac, 8bb0548, 2ddb546), each time after a command
//  changed under it.
//
//  The command table is the only real ground truth, so the
//  reference is rendered from it and checked by a test that
//  regenerates and diffs. Adding a command without updating
//  the reference now fails the build.
//

/** Where the rendered reference is written, relative to the package root. */
export const COMMANDS_REFERENCE_PATH = 'skill-data/core/references/commands.md';

const HEADER = `# teamai command reference

Every public command the installed CLI accepts, rendered from its own command
table. Hidden commands are left out: they are hook plumbing the CLI runs itself,
never something to type. Flags marked \`(hidden)\` work but are absent from
\`--help\`, so treat this file — not \`--help\` — as the complete list of flags.

Generated: do not edit by hand. Regenerate with
\`npx vitest run commands-reference -u\` after changing a command or a flag.
`;

function renderOption(option: Option): string {
  const hidden = option.hidden ? ' (hidden)' : '';
  const description = option.description ? ` — ${option.description}` : '';
  return `  - \`${option.flags}\`${hidden}${description}`;
}

function visibleOptions(command: Command): Option[] {
  // `-h, --help` is on every command and says nothing about the command.
  return command.options.filter((option) => option.long !== '--help');
}

/**
 * Subcommands `--help` lists. Hidden ones (`track`, `contribute-check`, …) are
 * hook plumbing the CLI calls itself; listing them would advertise them to the
 * agent as supported commands. The implicit `help` entry says nothing.
 */
function visibleSubcommands(command: Command): Command[] {
  return command.createHelp().visibleCommands(command).filter((sub) => sub.name() !== 'help');
}

function renderCommand(command: Command, parents: string[]): string[] {
  const path = [...parents, command.name()];
  const args = command.registeredArguments.map((a) => {
    const name = a.variadic ? `${a.name()}...` : a.name();
    return a.required ? `<${name}>` : `[${name}]`;
  });
  const usage = ['teamai', ...path, ...args].join(' ');

  const lines: string[] = [];
  const description = command.description();
  lines.push(`- \`${usage}\`${description ? ` — ${description}` : ''}`);
  for (const option of visibleOptions(command)) {
    lines.push(renderOption(option));
  }
  for (const sub of visibleSubcommands(command)) {
    lines.push(...renderCommand(sub, path).map((line) => `  ${line}`));
  }
  return lines;
}

/** Render the whole command table as the markdown the `core` skill serves. */
export function renderCommandsReference(program: Command): string {
  const sections: string[] = [HEADER];

  const globalOptions = visibleOptions(program);
  if (globalOptions.length > 0) {
    sections.push(['## Global options', '', ...globalOptions.map(renderOption).map((l) => l.slice(2))].join('\n'));
  }

  for (const command of visibleSubcommands(program)) {
    sections.push([`## ${command.name()}`, '', ...renderCommand(command, [])].join('\n'));
  }

  return sections.join('\n\n') + '\n';
}
