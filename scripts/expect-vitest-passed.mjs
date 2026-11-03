import fs from 'node:fs';

// A `-t` filter that matches nothing still exits 0. Fail unless the report
// passed exactly the expected number of tests.
const [file, expectedText] = process.argv.slice(2);
const expected = Number(expectedText);
const report = JSON.parse(fs.readFileSync(file, 'utf8'));

if (!Number.isInteger(expected) || report.numPassedTests !== expected) {
  console.error(`expected ${expectedText} passed tests in ${file}, got ${report.numPassedTests}`);
  process.exit(1);
}
