// Moves the local driver into src/workflow/drivers/local/ and the place helpers
// into src/workflow/place/, rewrites every relative specifier that names a moved
// file, then fails if any relative specifier in the repository resolves to no file.
// Run from anywhere in the checkout: node scripts/codemods/1304-move-drivers.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path/posix';
import { Language, Parser, Query } from 'web-tree-sitter';

const MOVES = [
  ['src/workflow/local-driver.ts', 'src/workflow/drivers/local/local-driver.ts'],
  ['src/workflow/local-tool-adapter.ts', 'src/workflow/drivers/local/local-tool-adapter.ts'],
  ['src/workflow/setup.ts', 'src/workflow/place/setup.ts'],
  ['src/workflow/worktree-snapshot.ts', 'src/workflow/place/worktree-snapshot.ts'],
];

const SPECIFIER_QUERY = `
(import_statement source: (string (string_fragment) @spec))
(export_statement source: (string (string_fragment) @spec))
(call_expression
  function: [(import) (identifier) (member_expression)] @callee
  arguments: (arguments . (string (string_fragment) @spec)))
`;
const MODULE_CALLEES = /^(import|require|vi\.(mock|doMock|unmock|doUnmock|importActual|importMock))$/;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

function fail(message) {
  console.error(`1304-move-drivers: ${message}`);
  process.exit(1);
}

function isFile(file) {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}

function sourceFiles() {
  return git('ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.mts', '*.cts', '*.tsx')
    .split('\n')
    .filter((file) => file && isFile(file));
}

function resolveSpecifier(fromDir, specifier) {
  const specPath = path.join(fromDir, specifier.split('?')[0]);
  const js = /\.([cm]?)js$/.exec(specPath);
  const stem = js ? specPath.slice(0, js.index) : specPath;
  const fromJs = js ? [`${stem}.${js[1]}ts`, `${stem}.tsx`, `${stem}.d.ts`] : [];
  const file = [specPath, ...fromJs, `${specPath}.ts`, `${specPath}.tsx`, `${specPath}/index.ts`].find(isFile);
  return file && { specPath, file };
}

function relativeSpecifier(fromDir, to) {
  const rel = path.relative(fromDir, to);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

const require = createRequire(import.meta.url);
await Parser.init({ locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm') });
const parser = new Parser();
const typescript = await Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm'));
parser.setLanguage(typescript);
const query = new Query(typescript, SPECIFIER_QUERY);

function relativeSpecifiers(text) {
  const nodes = [];
  for (const match of query.matches(parser.parse(text).rootNode)) {
    const spec = match.captures.find((capture) => capture.name === 'spec')?.node;
    const callee = match.captures.find((capture) => capture.name === 'callee')?.node;
    if (spec?.text.startsWith('.') && (!callee || MODULE_CALLEES.test(callee.text))) nodes.push(spec);
  }
  return nodes;
}

process.chdir(git('rev-parse', '--show-toplevel').trim());

const pending = MOVES.filter(([from, to]) => {
  if (isFile(from) && isFile(to)) fail(`both ${from} and ${to} exist; resolve by hand`);
  if (!isFile(from) && !isFile(to)) fail(`neither ${from} nor ${to} exists`);
  return isFile(from);
});
const destination = new Map(pending);

const rewrites = [];
for (const file of sourceFiles()) {
  const fileTo = destination.get(file) ?? file;
  const text = fs.readFileSync(file, 'utf8');
  const edits = [];
  for (const node of relativeSpecifiers(text)) {
    const resolved = resolveSpecifier(path.dirname(file), node.text);
    if (!resolved) continue;
    const targetTo = destination.get(resolved.file) ?? resolved.file;
    if (fileTo === file && targetTo === resolved.file) continue;
    if (targetTo !== resolved.file && path.dirname(resolved.specPath) !== path.dirname(resolved.file)) {
      fail(`${file}: '${node.text}' reaches a moved file through a directory index; rewrite it by hand`);
    }
    const specPathTo = targetTo === resolved.file ? resolved.specPath : path.join(path.dirname(targetTo), path.basename(resolved.specPath));
    const specifier = relativeSpecifier(path.dirname(fileTo), specPathTo);
    if (specifier !== node.text) edits.push({ node, specifier });
  }
  if (edits.length === 0) continue;
  let next = text;
  for (const { node, specifier } of edits.sort((a, b) => b.node.startIndex - a.node.startIndex)) {
    if (next.slice(node.startIndex, node.endIndex) !== node.text) fail(`${file}: parser offsets do not match the source text`);
    next = `${next.slice(0, node.startIndex)}${specifier}${next.slice(node.endIndex)}`;
  }
  fs.writeFileSync(file, next);
  rewrites.push(`${fileTo} (${edits.length})`);
}

for (const [from, to] of pending) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  git('mv', from, to);
  console.log(`moved ${from} -> ${to}`);
}
for (const rewrite of rewrites) console.log(`rewrote ${rewrite}`);

const unresolved = [];
let checked = 0;
for (const file of sourceFiles()) {
  for (const node of relativeSpecifiers(fs.readFileSync(file, 'utf8'))) {
    checked += 1;
    if (!resolveSpecifier(path.dirname(file), node.text)) unresolved.push(`${file}:${node.startPosition.row + 1}: '${node.text}' resolves to no file`);
  }
}
if (unresolved.length > 0) fail(`unresolved relative specifiers:\n${unresolved.join('\n')}`);
console.log(`resolution check: ${checked} relative specifiers resolve`);
