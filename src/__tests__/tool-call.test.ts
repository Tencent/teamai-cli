/**
 * The tool-call classifier's shell parsing (#884), on its public function.
 * The adoption contract itself is covered at the hook seam in
 * recall-attribution.test.ts; these rows pin the command forms a seam row
 * would need too much setup for.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { classifyShellCommand } from '../utils/shell-command.js';
import { getUserHome } from '../utils/home.js';
import { classifyToolCall } from '../utils/tool-call.js';

const CWD = path.resolve('/w');
const at = (file: string): string => path.resolve(CWD, file);

function shell(command: string, response: unknown = { stdout: '', stderr: '' }): ReturnType<typeof classifyToolCall> {
  return classifyToolCall({ tool_name: 'Bash', tool_input: { command }, tool_response: response, cwd: CWD });
}

describe('classifyToolCall', () => {
  it.each<[string, string[]]>([
    ['cat doc.md', ['doc.md']],
    ['cat -n a.md b.md', ['a.md', 'b.md']],
    ['cat -- -odd.md', ['-odd.md']],
    ['/bin/cat doc.md', ['doc.md']],
    ['LC_ALL=C cat doc.md', ['doc.md']],
    ['cat "my doc.md"', ['my doc.md']],
    ['cat doc.md\n', ['doc.md']],
    ['cat doc.md 2>/dev/null', ['doc.md']],
    ['bat --style plain doc.md', ['doc.md']],
    ['batcat -r 1:40 doc.md', ['doc.md']],
    ['less -p timeout doc.md', ['doc.md']],
    ['more doc.md', ['doc.md']],
    ['head -n 5 doc.md', ['doc.md']],
    ['head -5 doc.md', ['doc.md']],
    ['tail -n +10 doc.md', ['doc.md']],
    ['nl -ba doc.md', ['doc.md']],
    ["nl -s ' ' doc.md", ['doc.md']],
    ['sed -n 5p doc.md', ['doc.md']],
    ["sed -n '1,80p' doc.md", ['doc.md']],
    ["sed -ne '1,5p' doc.md", ['doc.md']],
    ['sed -n -e 1p -e 9,12p doc.md', ['doc.md']],
    ['sed --quiet --expression=3p doc.md', ['doc.md']],
    ['cat doc.md # other.md', ['doc.md']],
    ['cat doc.md #other.md', ['doc.md']],
    ['cat a#b.md', ['a#b.md']],
    ['cat "#x.md" \'#y.md\'', ['#x.md', '#y.md']],
    ['# a note\ncat doc.md', ['doc.md']],
    ['cat my\\ doc.md', ['my doc.md']],
    ['cat \\#x.md \\"y\\".md', ['#x.md', '"y".md']],
    ['cat "a\\"b.md"', ['a"b.md']],
  ])('%j reads %j', (command, files) => {
    expect(shell(command)).toMatchObject({ category: 'read', paths: files.map(at), simple: true, status: 'success' });
  });

  // As written, before any path resolution: outside quotes a backslash escapes only a shell-special character.
  it.each<[string, string[]]>([
    ['cat C:\\kb\\learnings\\x.md', ['C:\\kb\\learnings\\x.md']],
    ['cat a\\\\b.md', ['a\\b.md']],
    ['cat "c\\\\d.md" "e\\f.md" \'g\\ h.md\'', ['c\\d.md', 'e\\f.md', 'g\\ h.md']],
    ['cat x.md\\', ['x.md\\']],
  ])('%j names %j', (command, files) => {
    expect(classifyShellCommand(command)).toMatchObject({ category: 'read', paths: files });
  });

  it.each([
    'cat',
    'cat -',
    'cat *.md',
    'cat $(ls)',
    'cat doc.md > copy.md',
    'cat notes.txt > doc.md',
    'cat < doc.md',
    'cat doc.md >&2',
    'cat doc.md || true',
    'cat doc.md; echo ok',
    'cat doc.md &',
    'cat doc.md\necho ok',
    'echo x | cat doc.md',
    'echo "cat doc.md"',
    'sed 1p doc.md',
    "sed -n 's/a/b/p' doc.md",
    'sed -n -i 1p doc.md',
    'sed -i.bak -n 1p doc.md',
    'sed --in-place -n 1p doc.md',
    'sed -n -f print.sed doc.md',
    'nl -s doc.md',
    'head -n 5',
    '# cat doc.md',
  ])('%j is no read', (command) => {
    expect(shell(command)).toMatchObject({ category: 'shell', paths: [], command });
  });

  it('type and gc are PowerShell\'s aliases only under a PowerShell tool or with a Windows path; Get-Content is everywhere', () => {
    const ps = (command: string): ReturnType<typeof classifyToolCall> =>
      classifyToolCall({ tool_name: 'PowerShell', tool_input: { command }, tool_response: { stdout: '' }, cwd: CWD });
    expect(shell('type doc.md')).toMatchObject({ category: 'shell', paths: [] });
    expect(shell('gc /w/doc.md')).toMatchObject({ category: 'shell', paths: [] });
    expect(shell('type C:\\kb\\doc.md').category).toBe('read');
    expect(shell('gc .\\doc.md').category).toBe('read');
    expect(shell("type '\\\\server\\share\\doc.md'").category).toBe('read');
    expect(shell('type C:\\kb\\doc.md /w/b.md').category).toBe('shell');
    expect(ps('type doc.md')).toMatchObject({ category: 'read', paths: [at('doc.md')] });
    expect(classifyToolCall({ tool_name: 'powershell', tool_input: { command: 'gc doc.md' }, tool_response: {}, cwd: CWD }).category).toBe('read');
    expect(shell('Get-Content doc.md')).toMatchObject({ category: 'read', paths: [at('doc.md')] });
  });

  it('an unquoted leading ~/, $HOME/ or ${HOME}/ is the home directory; a quoted ~ is a literal one', () => {
    const home = getUserHome();
    for (const operand of ['~/doc.md', '$HOME/doc.md', '${HOME}/doc.md']) {
      expect(shell(`cat ${operand}`)).toMatchObject({ category: 'read', paths: [path.join(home, 'doc.md')] });
    }
    expect(shell("cat '~/doc.md' \"~/b.md\" a~/c.md")).toMatchObject({ category: 'read', paths: [at('~/doc.md'), at('~/b.md'), at('a~/c.md')] });
    expect(shell("cat '$HOME/doc.md'")).toMatchObject({ category: 'shell', paths: [] });
  });

  it.each(['"$HOME/doc.md"', '"${HOME}/doc.md"'])('expands double-quoted HOME in %s', (operand) => {
    expect(shell(`cat ${operand}`)).toMatchObject({ category: 'read', paths: [path.join(getUserHome(), 'doc.md')] });
  });

  it.each(["'$HOME/doc.md'", "'${HOME}/doc.md'", '"\\$HOME/doc.md"'])('keeps literal HOME in %s', (operand) => {
    expect(shell(`cat ${operand}`)).toMatchObject({ category: 'shell', paths: [] });
  });

  it('a leading ~\\, $HOME\\ or ${HOME}\\ is the home directory too', () => {
    for (const ref of ['~', '$HOME', '${HOME}']) {
      expect(shell(`cat ${ref}\\.codex\\skills\\x\\SKILL.md`)).toMatchObject({ category: 'read', paths: [`${getUserHome()}\\.codex\\skills\\x\\SKILL.md`] });
    }
  });

  it('a pipeline that starts with the reader is a read, but not a simple one', () => {
    expect(shell('cat doc.md 2>&1 | head -n 20')).toMatchObject({ category: 'read', paths: [at('doc.md')], simple: false });
  });

  // A command list is a read only as reads and guards joined by `;`, `&&` or newlines, of what its last `&&` chain read.
  it.each<[string, string[]]>([
    ['pwd; cat /abs/SKILL.md', ['/abs/SKILL.md']],
    ['pwd\ncat doc.md', ['doc.md']],
    ['test -f doc.md && cat doc.md', ['doc.md']],
    ['[ -s doc.md ] && cat doc.md', ['doc.md']],
    ['cd docs && cat a.md', ['docs/a.md']],
    ['cd docs && cd sub && sed -n 1,5p a.md', ['docs/sub/a.md']],
    ['cd /abs && cat a.md /b.md', ['/abs/a.md', '/b.md']],
    ['cd docs; cat /abs/doc.md', ['/abs/doc.md']],
    ['pwd; cat ~/doc.md', [path.join(getUserHome(), 'doc.md')]],
    ['cat doc.md;', ['doc.md']],
    ['test -f /abs/SKILL.md && cat /abs/SKILL.md;', ['/abs/SKILL.md']],
    ['cat doc.md && echo ok', ['doc.md']],
    ['cat a.md && head -n 5 b.md', ['a.md', 'b.md']],
    ['sed -n 1,5p doc.md && sed -n 6,9p doc.md', ['doc.md']],
    ['cat a.md; cat b.md', ['b.md']],
    ['ls docs 2>/dev/null; true && : && echo "a; b" && cat doc.md 2>&1', ['doc.md']],
  ])('the command list %j reads %j', (command, files) => {
    expect(shell(command)).toMatchObject({ category: 'read', paths: files.map(at), simple: false, status: 'success' });
  });

  it.each<[string, string]>([
    ['a heredoc', "cat <<'EOF'\ncat /abs/SKILL.md\nEOF"],
    ['a read after false &&', 'false && cat /abs/SKILL.md; echo ok'],
    ['exit', 'exit 0; cat /abs/SKILL.md'],
    ['a substitution in quotes', 'echo "$(echo "x; cat /abs/SKILL.md; echo x")"'],
    ['exit in a compound', 'if true; then exit 0; fi; cat /abs/SKILL.md'],
    ['a read followed by ;', "printf '%' && cat /abs/SKILL.md; echo ok"],
    ['exit after a pipe', 'echo ok | exit 0; cat /abs/SKILL.md'],
    ['||', 'true || false && cat /abs/SKILL.md'],
    ['a redirect that can fail', 'true 2>/nonexistent/err && cat /abs/SKILL.md; echo ok'],
    ['an assignment', 'X=$(false) && cat /abs/SKILL.md; echo ok'],
    ['a compound', 'if true; then true; fi && cat /abs/SKILL.md'],
    ['a compound before ;', 'if true; then echo exit; fi; cat /abs/SKILL.md'],
    ['a function', 'f() { exit 0; }; cat /abs/SKILL.md'],
    ['exec', 'exec 2>/tmp/teamai-review.log; cat /abs/SKILL.md'],
    ['a fallback', 'test -f /missing || true && cat /abs/SKILL.md; echo ok'],
    ['a guard with an argument', 'pwd --invalid && cat /abs/SKILL.md; echo ok'],
    ['a guard by path', '/nonexistent/true && cat /abs/SKILL.md; echo ok'],
    ['eval', "eval 'exit 0'; cat /abs/SKILL.md"],
    ['a function named like a reader', 'cat() { echo placeholder; }; cat /abs/SKILL.md'],
    ['a case in a substitution', 'echo "$(case x in x) echo "a; cat /abs/SKILL.md; echo b";; esac)"'],
    ['a relative read after cd ;', 'cat a.md; cd subdir; cat a.md; echo ok'],
    ['a subshell function', 'f() (true); cat /abs/SKILL.md'],
    ['a case', 'case x in x) echo esac;; esac; cat /abs/SKILL.md'],
    ['a pipeline', 'pwd; cat /abs/SKILL.md | head -n 5'],
    ['a background command', 'pwd; cat /abs/SKILL.md &'],
    ['a stdout redirect', 'pwd; cat /abs/SKILL.md > copy.md'],
    ['a stderr redirect to a file', 'pwd; cat /abs/SKILL.md 2>err.log'],
    ['a relative read after cd ; alone', 'cd docs; cat a.md'],
    ['cd home', 'cd ~ && cat a.md'],
    ['cd back', 'cd - && cat a.md'],
    ['cd to the dir stack', 'cd +1 && cat a.md'],
    ['cd by another name', 'CD docs && cat a.md'],
    ['builtin cd', 'builtin cd docs && cat a.md'],
    ['a group', '{ cd docs; cat a.md; }'],
    ['a subshell', '(cat /abs/SKILL.md)'],
    ['source', 'source env.sh; cat /abs/SKILL.md'],
    ['.', '. ./env.sh; cat /abs/SKILL.md'],
    ['alias', 'alias cat=true; cat /abs/SKILL.md'],
    ['set', 'set -e; cat /abs/SKILL.md'],
    ['trap', "trap 'exit 0' EXIT; cat /abs/SKILL.md"],
    ['! before a guard', '! true; cat /abs/SKILL.md'],
    ['a loop', 'while true; do cat /abs/SKILL.md; done'],
    ['an assignment alone', 'X=1; cat /abs/SKILL.md'],
    ['an assignment before a read', 'pwd; LC_ALL=C cat /abs/SKILL.md'],
    ['a reader by path', 'pwd; /bin/cat /abs/SKILL.md'],
    ['a reader by .exe', 'pwd; cat.exe /abs/SKILL.md'],
    ['a parameter', 'echo $HOME; cat /abs/SKILL.md'],
    ['a comment', 'pwd; cat /abs/SKILL.md # note'],
    ['an empty command', 'pwd;; cat /abs/SKILL.md'],
    ['an empty command after &&', 'pwd && ; cat /abs/SKILL.md'],
    ['a final &&', 'pwd; cat /abs/SKILL.md &&'],
    ['an unclosed quote', "pwd; cat '/abs/SKILL.md"],
    ['a line continuation', 'pwd; cat \\\n/abs/SKILL.md'],
    ['a carriage return', 'pwd\r\ncat /abs/SKILL.md'],
    ['[[', '[[ -f a.md ]] && cat a.md'],
    ['a test of two files', 'test -f a.md -a -f b.md && cat a.md'],
    ['true with an argument', 'true x && cat a.md'],
    ['a search', 'grep -q x a.md && cat /abs/SKILL.md'],
    ['PowerShell cd', 'Set-Location docs; Get-Content /abs/doc.md'],
  ])('a command list with %s (%j) reads nothing', (_kind, command) => {
    expect(shell(command)).toMatchObject({ category: 'shell', paths: [] });
  });

  it.each<[string, string, string[]]>([
    ['pwd; cat /abs/SKILL.md', '/w\n---', ['/abs/SKILL.md']],
    ['echo x && cat doc.md', 'x\n---', ['doc.md']],
    ['pwd; cat a.md doc.md', '/w\n# a\ncat: doc.md: No such file or directory', ['a.md']],
    ['cat a.md && cat b.md', '---', ['a.md']],
    ['test -f doc.md && cat doc.md', '---', []],
    ['cd docs && cat a.md', '---', []],
    ['ls docs && cat doc.md', '---', []],
  ])('status unknown: the command list %j with output %j reads %j, after nothing that can fail', (command, output, files) => {
    expect(shell(command, output)).toMatchObject({ status: 'unknown', paths: files.map(at) });
  });

  it('a Read tool reads its file_path, resolved against the cwd when there is one', () => {
    expect(classifyToolCall({ tool_name: 'Read', tool_input: { file_path: 'doc.md' }, tool_response: {}, cwd: CWD }))
      .toEqual({ category: 'read', paths: [at('doc.md')], status: 'success', simple: true });
    expect(classifyToolCall({ tool_name: 'read_file', tool_input: { file_path: 'learnings/doc.md' }, tool_response: {} }))
      .toMatchObject({ category: 'read', paths: ['learnings/doc.md'] });
  });

  it('status: a plain-string response (Codex) is unknown, a non-zero exitCode is a failure', () => {
    expect(shell('cat doc.md', 'the file text')).toMatchObject({ status: 'unknown', output: 'the file text' });
    expect(shell('cat doc.md', { stdout: 'x', exitCode: 0 })).toMatchObject({ status: 'success', output: 'x' });
    expect(shell('cat doc.md', { stdout: '', exitCode: 1 })).toMatchObject({ status: 'failure' });
  });

  it.each<[string, string]>([
    ['cat doc.md', 'cat: doc.md: Permission denied'],
    ['cat doc.md', 'cat: doc.md: No such file or directory\n'],
    ['/usr/bin/head -n 5 doc.md', '/usr/bin/head: doc.md: No such file or directory\nhead: doc.md: x\n'],
    ["sed -n '1,5p' doc.md", "sed: can't read doc.md: No such file or directory"],
    ['grep needle doc.md', 'grep: doc.md: Permission denied'],
    ['rg -n needle learnings', 'rg: learnings/a.md: Permission denied (os error 13)'],
    ['cat doc.md', 'bash: line 1: cat: command not found'],
    ['head -n 5 doc.md', 'sh: 1: head: not found\n'],
    ['cat doc.md', 'zsh: permission denied: doc.md'],
    ['cat doc.md', '/bin/bash: line 1: cat: command not found'],
  ])('status unknown: %j with output %j, only its command\'s errors, is a failure', (command, output) => {
    expect(shell(command, output)).toMatchObject({ status: 'failure', paths: [] });
  });

  it('status unknown: its command\'s error lines are no content, but the lines around them are', () => {
    expect(shell('cat a.md doc.md', 'cat: a.md: No such file or directory\n---')).toMatchObject({ status: 'unknown', paths: [at('doc.md')] });
    expect(shell('grep -rn needle learnings', 'grep: learnings/b.md: Permission denied\nlearnings/a.md:3:x'))
      .toMatchObject({ status: 'unknown', paths: [at('learnings/a.md')] });
    expect(shell('cat doc.md', 'grep: doc.md: said by another command')).toMatchObject({ status: 'unknown', paths: [at('doc.md')] });
    expect(shell('cat doc.md', { stdout: 'cat: doc.md: Permission denied' })).toMatchObject({ status: 'success' });
  });

  it.each<[string, string, string[]]>([
    ['cat a.md doc.md', '# a\ncat: doc.md: Permission denied', ['a.md']],
    ['cat a.md ./doc.md', '# a\ncat: doc.md: Permission denied', ['a.md']],
    ['cat a.md doc.md', `# a\ncat: ${at('doc.md')}: Permission denied`, ['a.md']],
    ['/bin/cat a.md "my doc.md"', "# a\n/bin/cat: 'my doc.md': No such file or directory", ['a.md']],
    ['cat.exe a.md doc.md', '# a\ncat.exe: doc.md: Permission denied', ['a.md']],
    ['head -n 5 a.md doc.md', '==> a.md <==\n# a\nhead: doc.md: x\n', ['a.md']],
    ['cat a.md doc.md', '# a\ncat: b.md: No such file or directory', ['a.md', 'doc.md']],
    ['cat a.md doc.md', '# a\ngrep: doc.md: No such file or directory', ['a.md', 'doc.md']],
  ])('status unknown: %j with output %j reads only %j: an operand its command\'s error names is dropped', (command, output, files) => {
    expect(shell(command, output)).toMatchObject({ category: 'read', status: 'unknown', paths: files.map(at) });
  });

  it('status success: an error line names no operand to drop', () => {
    expect(shell('cat a.md doc.md', { stdout: '# a\ncat: doc.md: Permission denied' }).paths).toEqual([at('a.md'), at('doc.md')]);
  });

  it.each<[string, string, string[]]>([
    ['grep -rn timeout learnings', 'learnings/a.md:3:x\nlearnings/sub/b.md:9:y', ['learnings/a.md', 'learnings/sub/b.md']],
    ['grep -e timeout -e pool learnings', 'learnings/a.md:x', ['learnings/a.md']],
    ['grep -A 2 timeout learnings', 'learnings/a.md:3:x\nlearnings/a.md-4-y', ['learnings/a.md']],
    ['grep --include=*.md -rn timeout .', './learnings/a.md:3:x', ['learnings/a.md']],
    ['egrep -rn "a|b" learnings 2>/dev/null', 'learnings/a.md:1:a', ['learnings/a.md']],
    ['rg -n timeout', 'learnings/a.md:3:x', ['learnings/a.md']],
    ['rg -g "*.md" -t md timeout learnings', 'learnings/a.md:x', ['learnings/a.md']],
    ['rg -L timeout learnings', 'learnings/a.md:x', ['learnings/a.md']],
    ['rg -n timeout learnings/*.md', 'learnings/a.md:3:x', ['learnings/a.md']],
    ['git grep -n timeout', 'learnings/a.md:3:x', ['learnings/a.md']],
    ['ag timeout learnings', 'learnings/a.md:3:x', ['learnings/a.md']],
    ['ack --match timeout learnings', 'learnings/a.md:3:x', ['learnings/a.md']],
    ['grep -n timeout learnings/a.md', '3:x', ['learnings/a.md']],
    ['grep -H timeout learnings/a.md', 'learnings/a.md:x', ['learnings/a.md']],
    ['grep -rn timeout learnings', 'Found 2 matches\nlearnings/a.md:', ['learnings/a.md']],
  ])('%j with output %j shows lines of %j', (command, stdout, files) => {
    expect(shell(command, { stdout })).toMatchObject({ category: 'search', paths: files.map(at), simple: true });
  });

  // The hook reads no file: a lone operand without a file name may be a directory, so it records the operand,
  // which only ever equals a doc's path when it is that doc (the recorder keeps only `.md` paths).
  it.each<[string, string]>([
    ['grep -rn timeout learnings', 'learnings/a.md\nlearnings/b.md'],
    ['grep -rn timeout learnings', 'other/a.md:3:x'],
    ['grep timeout learnings/a.md', '../b.md: see b'],
  ])('%j with output %j shows the lines of its operand only', (command, stdout) => {
    expect(shell(command, { stdout }).paths).toEqual([at(command.split(' ').pop()!)]);
  });

  it.each<[string, string]>([
    ['grep -rn timeout learnings', ''],
    ['grep -rn timeout learnings other', 'learnings/a.md\nthird/a.md:3:x'],
    ['grep -c timeout learnings/a.md', '3'],
    ['grep -rnc timeout learnings', 'learnings/a.md:3'],
    ['rg --count-matches timeout learnings', 'learnings/a.md:3'],
    ['git grep --count timeout', 'learnings/a.md:3'],
    ['grep -rn timeout learnings/a.md | wc -l', '3'],
    ['grep -rn timeout learnings > hits.txt', 'learnings/a.md:3:x'],
    ['grep -rn timeout learnings && echo ok', 'learnings/a.md:3:x'],
  ])('%j with output %j shows no file\'s lines', (command, stdout) => {
    expect(shell(command, { stdout }).paths).toEqual([]);
  });

  it.each([
    'grep -l timeout learnings', 'grep -rL timeout learnings', 'grep --files-with-matches timeout learnings',
    'rg -l timeout', 'rg --files learnings', 'git grep --name-only timeout', 'ag -g md learnings', 'ack -f learnings',
    'ls learnings', 'ls -la learnings/a.md', 'find learnings -name "*.md"', 'fd md learnings', 'tree learnings',
    'git ls-files learnings',
  ])('%j is a listing', (command) => {
    expect(shell(command, { stdout: 'learnings/a.md:3:x' })).toMatchObject({ category: 'list', paths: [] });
  });

  it('a search tool shows the lines of the files its content names, never of its filenames list', () => {
    const grep = (input: Record<string, unknown>, response: unknown, agent?: string): ReturnType<typeof classifyToolCall> =>
      classifyToolCall({ tool_name: 'Grep', tool_input: { pattern: 'x', ...input }, tool_response: response, cwd: CWD }, agent);
    expect(grep({ path: 'learnings' }, { filenames: [at('learnings/a.md')] })).toMatchObject({ category: 'list', paths: [] });
    expect(grep({ path: 'learnings', output_mode: 'content' }, { content: `${at('learnings/a.md')}:3:x` }))
      .toMatchObject({ category: 'search', paths: [at('learnings/a.md')] });
    expect(grep({ output_mode: 'content' }, { content: 'learnings/a.md:3:x' })).toMatchObject({ paths: [at('learnings/a.md')] });
    expect(grep({ path: 'learnings', output_mode: 'count' }, { content: `${at('learnings/a.md')}:3` })).toMatchObject({ paths: [] });
    expect(classifyToolCall({ tool_name: 'search_content', tool_input: { pattern: 'x', path: at('learnings/a.md') }, tool_response: {} }))
      .toMatchObject({ category: 'list' });
    // OpenCode: an absolute `path:` header, then `  Line N: text`.
    expect(classifyToolCall({ tool_name: 'grep', tool_input: { pattern: 'x' }, tool_response: `Found 1 matches\n${at('learnings/a.md')}:\n  Line 3: x`, cwd: CWD }))
      .toMatchObject({ category: 'search', paths: [at('learnings/a.md')], status: 'unknown', simple: true });
    // OMP's markdown tree and Cursor's Grep: no evidence yet.
    for (const agent of ['omp', 'cursor']) {
      expect(classifyToolCall({ tool_name: agent === 'omp' ? 'grep' : 'Grep', tool_input: { pattern: 'x', path: at('learnings/a.md'), output_mode: 'content' }, tool_response: '3:x', cwd: CWD }, agent))
        .toMatchObject({ category: 'search', paths: [] });
    }
  });

  it('a line counts only when it starts with a file name, then :<line>: or :; a one-file search\'s lines name no path', () => {
    const doc = at('learnings/a.md');
    const grep = (input: Record<string, unknown>, response: unknown, agent?: string): string[] =>
      classifyToolCall({ tool_name: 'grep', tool_input: { pattern: 'x', ...input }, tool_response: response, cwd: CWD }, agent).paths;
    // The doc searched: Claude's -n false line, Pi's basename line. Never `<doc>/<text>`.
    expect(classifyToolCall({ tool_name: 'Grep', tool_input: { pattern: 'x', path: doc, output_mode: 'content', '-n': false },
      tool_response: { content: 'Cause: the pool' }, cwd: CWD }).paths).toEqual([doc]);
    expect(grep({ path: doc }, 'a.md:5: x', 'pi')).toEqual([doc]);
    // A directory searched: text before a colon is no path.
    expect(shell('grep -rh pool learnings', { stdout: 'Cause: the pool\nFix: 12: raise it' }).paths).not.toContain(at('learnings/Cause'));
    expect(shell('grep -rh pool learnings', { stdout: 'Fix: 12: raise it' }).paths).not.toContain(at('learnings/Fix'));
    expect(grep({ path: at('learnings') }, 'sub/b.md:5: x', 'pi')).toEqual([at('learnings/sub/b.md')]);
    expect(grep({ path: at('learnings') }, 'Cause:5: x', 'pi')).not.toContain(at('learnings/Cause'));
  });

  it.each(['No files found', 'No matches found', 'Found 0 matches', '\nNo matches found\n'])(
    'a one-file search tool whose output is only its status line %j shows nothing; a shell search\'s is a line of the file', (output) => {
      const doc = at('learnings/a.md');
      expect(classifyToolCall({ tool_name: 'grep', tool_input: { pattern: 'x', path: doc }, tool_response: output, cwd: CWD }).paths).toEqual([]);
      expect(shell('grep found learnings/a.md', { stdout: output }).paths).toEqual([doc]);
    });

  it('an unknown tool name is unknown, whatever its input names', () => {
    expect(classifyToolCall({ tool_name: 'OpenDocument', tool_input: { file_path: '/w/doc.md', command: 'cat doc.md' }, tool_response: {} }))
      .toEqual({ category: 'unknown', paths: [], status: 'success', simple: false });
  });
});
