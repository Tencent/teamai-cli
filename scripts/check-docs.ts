import { readMarkdown } from './doc-checks/read-markdown.js';
import fs from 'node:fs';
import { setSilent } from '../src/utils/logger.js';
import { loadCommandTable } from './command-table.js';
import path from 'node:path';
import { TOOL_SUPPORT_PAGES, renderToolSupportPage } from './tool-support.js';
import { COMMANDS_REFERENCE_PATH, renderCommandsReference } from './commands-reference.js';
import { TOOL_ORDER } from '../src/tool-registry.js';

const root = process.cwd();
const CHECKS = ['readme-matrix', 'skill-commands-exist', 'team-wiki-codebase-skill', 'skill-content', 'workflow-docs-examples', 'glossary-terms', 'lint-rules-readme'] as const;
const USAGE = `Usage: node scripts/check-docs.mjs [--write] [--only=<check>]\n<check> is one of: ${CHECKS.join(', ')}`;

let write = false;
let only: (typeof CHECKS)[number] | undefined;

for (const arg of process.argv.slice(2)) {
  const name = CHECKS.find((check) => arg === `--only=${check}`);

  if (arg === '--write') write = true;
  else if (name && !only) only = name;
  else throw new Error(USAGE);
}

const program = await loadCommandTable();

const generated = [
  { file: COMMANDS_REFERENCE_PATH, content: () => renderCommandsReference(program) },
  { file: TOOL_SUPPORT_PAGES.en, content: () => renderToolSupportPage('en') },
  { file: TOOL_SUPPORT_PAGES['zh-CN'], content: () => renderToolSupportPage('zh-CN') },
  // The shipped tool ids, which teamai/tool-facts reads: the lint plugin is plain JavaScript and cannot import the registry.
  { file: 'oxlint-plugin-teamai/tool-ids.generated.json', content: () => `${JSON.stringify(TOOL_ORDER, null, 2)}\n` },
];

for (const output of generated) {
  const file = path.join(root, output.file);
  const content = output.content();

  if (write) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  else if (!fs.existsSync(file) || readMarkdown(file) !== content) {
    console.error(`Generated documentation is stale: ${output.file}. Run node scripts/check-docs.mjs --write.`);
    process.exitCode = 1;
  }
}

setSilent(true);

// --only narrows these checks; the generated files above are always compared.
for (const name of only ? [only] : CHECKS) await import(`./doc-checks/${name}.js`);

if (!process.exitCode) console.log('Documentation checks passed.');
