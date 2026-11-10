import { check } from '../doc-check.js';
import { GLOSSARY_PATH, findAvoidSpellings } from '../glossary-avoid.js';

await check('uses no quoted glossary Avoid spelling', () => {
  const found = findAvoidSpellings(process.cwd()).map(({ spelling, file, count }) => `${file} uses "${spelling}" ${count} times.`);

  if (found.length > 0) {
    throw new Error(`${found.join('\n')}\nUse the term ${GLOSSARY_PATH} gives instead, or quote a label teamai prints as \`code\`.`);
  }
});
