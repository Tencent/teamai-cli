import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL_DATA = path.join(ROOT, 'skill-data');
/** The deployed stub is the one file agents always hold, so its commands are checked too. */
const DEPLOYED_STUB = path.join(ROOT, 'skills', 'teamai', 'SKILL.md');

/** Every `teamai …` invocation written in the served skill content. */
interface Invocation {
  file: string;
  line: number;
  text: string;
}

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.isFile() && entry.name.endsWith('.md') ? [full] : [];
  });
}

function collectInvocations(): Invocation[] {
  const found: Invocation[] = [];
  for (const file of [...markdownFiles(SKILL_DATA), DEPLOYED_STUB]) {
    const relative = path.relative(ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');

    // A description sentence naming the CLI is prose, not an invocation.
    let start = 0;
    if (lines[0] === '---') {
      const close = lines.indexOf('---', 1);
      if (close > 0) start = close + 1;
    }

    lines.slice(start).forEach((line, offset) => {
      // Inside backticks, or a bare command line inside a fenced block.
      const spans = [...line.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
      if (/^\s*teamai\s/.test(line)) spans.push(line.trim());
      for (const span of spans) {
        const text = span.trim().replace(/\s+#.*$/, '');
        // The token after `teamai` has to look like a command name; prose such
        // as "teamai — Team AI …" or "teamai …" is a mention, not a call.
        if (!/^teamai\s+(-{1,2}[a-z]|[a-z][a-z-]*(\s|$))/.test(text)) continue;
        found.push({ file: relative, line: start + offset + 1, text });
      }
    });
  }
  return found;
}

/** Walk the command chain an invocation names, and return the command it lands on. */
function resolveCommand(program: Command, tokens: string[]): { command: Command; rest: string[] } {
  let command = program;
  let index = 0;
  while (index < tokens.length) {
    const next = command.commands.find(
      (c) => c.name() === tokens[index] || c.aliases().includes(tokens[index]),
    );
    if (!next) break;
    command = next;
    index += 1;
  }
  return { command, rest: tokens.slice(index) };
}

function knownFlags(command: Command, program: Command): Set<string> {
  const flags = new Set<string>(['--help', '-h']);
  for (const option of [...command.options, ...program.options]) {
    if (option.long) flags.add(option.long);
    if (option.short) flags.add(option.short);
  }
  return flags;
}

function validate(program: Command, invocations: Invocation[]): string[] {
  const problems: string[] = [];

  for (const invocation of invocations) {
    const tokens = invocation.text.split(/\s+/).slice(1).filter(Boolean);
    if (tokens.length === 0) continue;

    const { command, rest } = resolveCommand(program, tokens);
    const where = `${invocation.file}:${invocation.line}  ${invocation.text}`;

    if (command === program && !tokens[0].startsWith('-')) {
      problems.push(`${where}  → unknown command "${tokens[0]}"`);
      continue;
    }

    // A group with subcommands and no argument of its own can only be followed
    // by one of them (or a flag), so any other word is a subcommand that does
    // not exist. Placeholders such as `<name>` stand for one and are skipped.
    const next = rest[0];
    if (
      next !== undefined && command.commands.length > 0 && command.registeredArguments.length === 0
      && !next.startsWith('-') && !/[<>[\]{}"'…]/.test(next)
    ) {
      problems.push(`${where}  → unknown subcommand "${next}" for \`teamai ${command.name()}\``);
      continue;
    }

    const flags = knownFlags(command, program);
    for (const token of rest) {
      if (!token.startsWith('-') || token === '-') continue;
      const flag = token.split('=')[0];
      // Placeholders and prose inside an example are not flags to resolve.
      if (/[<>[\]{}"']/.test(flag)) continue;
      if (!flags.has(flag)) {
        problems.push(`${where}  → unknown flag "${flag}" for \`teamai ${command.name()}\``);
      }
    }
  }

  return problems;
}

describe('commands named by the served skill content', () => {
  it('all exist in the CLI command table', async () => {
    vi.stubEnv('TEAMAI_COMMAND_TABLE_ONLY', '1');
    const { program } = await import('../index.js');

    const problems = validate(program, collectInvocations());
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });

  it('catches the drift it exists to catch', async () => {
    vi.stubEnv('TEAMAI_COMMAND_TABLE_ONLY', '1');
    const { program } = await import('../index.js');

    // `teamai extract graph` is the command the wiki skill advertised until this
    // change (issue #678, defect D1); the flag is invented.
    const problems = validate(program, [
      { file: 'synthetic.md', line: 1, text: 'teamai extract graph' },
      { file: 'synthetic.md', line: 2, text: 'teamai codebase --no-such-flag' },
      // A misspelled or renamed subcommand inside a group: the group matches, so
      // without its own check the typo is read as an argument.
      { file: 'synthetic.md', line: 3, text: 'teamai skill gett core' },
      // A group that takes an argument of its own is left alone: `enabel` is a query.
      { file: 'synthetic.md', line: 4, text: 'teamai recall enabel' },
    ]);

    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('unknown command "extract"');
    expect(problems[1]).toContain('unknown flag "--no-such-flag"');
    expect(problems[2]).toContain('unknown subcommand "gett" for `teamai skill`');
  });
});
