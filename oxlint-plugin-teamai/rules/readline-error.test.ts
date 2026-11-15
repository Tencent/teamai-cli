import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/readline-error', { filename: 'packages/runtime-x/src/socket.ts' });

const MESSAGE = 'readline re-emits its input\'s errors on the interface';

rule.invalid('rejects reading a socket\'s lines with no error listener', `import net from 'node:net';
import readline from 'node:readline';
export const read = (client: net.Socket) => readline.createInterface({ input: client }).on('line', () => {});`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects an interface bound to a name that only listens for lines', `import { createInterface } from 'node:readline';
export const read = (stream: NodeJS.ReadableStream) => {
  const lines = createInterface({ input: stream });
  lines.on('line', () => {});
  lines.on('close', () => {});
};`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects a child\'s output read in a test without an error listener', `import { spawn } from 'node:child_process';
import readline from 'node:readline';
const child = spawn('x');
readline.createInterface({ input: child.stdout }).on('line', () => {});`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'src/__tests__/x.test.ts' });

rule.invalid('rejects an error listener on another name than the interface', `import readline from 'node:readline';
export const read = (input: NodeJS.ReadableStream, other: NodeJS.EventEmitter) => {
  const lines = readline.createInterface({ input });
  other.on('error', () => {});
  return lines;
};`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects an interface whose name only another function\'s interface listens for errors on', `import readline from 'node:readline';
export const safe = (input: NodeJS.ReadableStream) => {
  const lines = readline.createInterface({ input });
  lines.on('error', () => {});
  return lines;
};
export const unsafe = (input: NodeJS.ReadableStream) => {
  const lines = readline.createInterface({ input });
  lines.on('line', () => {});
};`, (output) => {
  expect(output.match(/readline re-emits/g)).toHaveLength(1);
  expect(output).toContain('"line":8,"column":17');
});

rule.invalid('rejects the positional form with no error listener', `import readline from 'node:readline';
export const read = (input: NodeJS.ReadableStream) => readline.createInterface(input).on('line', () => {});`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.valid('allows an error listener added in a callback inside the function that made the interface', `import readline from 'node:readline';
export const read = (input: NodeJS.ReadableStream) => {
  const lines = readline.createInterface({ input });
  return new Promise((resolve, reject) => {
    lines.on('error', reject);
    lines.on('close', resolve);
  });
};`);

rule.valid('allows an error listener chained on the interface', `import readline from 'node:readline';
export const read = (input: NodeJS.ReadableStream) => readline.createInterface({ input }).on('line', () => {}).once('error', () => {});`);

rule.valid('allows an error listener on the name the interface is bound to', `import readline from 'node:readline';
export const read = (input: NodeJS.ReadableStream) => {
  const lines = readline.createInterface({ input });
  lines.on('error', () => {});
  lines.on('line', () => {});
};`);

rule.valid('allows reading the lines with for await, which rejects on an error', `import fs from 'node:fs';
import readline from 'node:readline';
export async function count(file: string): Promise<number> {
  let n = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const _ of lines) n += 1;
  for await (const _ of readline.createInterface({ input: fs.createReadStream(file) })) n += 1;
  return n;
}`);

rule.valid('allows the async iterator, which rejects on an error', `import readline from 'node:readline';
export const first = (input: NodeJS.ReadableStream) => readline.createInterface({ input })[Symbol.asyncIterator]().next();`);

rule.valid('leaves a terminal\'s process input alone, where an error ends the command', `import { createInterface } from 'node:readline/promises';
export const ask = () => createInterface({ input: process.stdin, output: process.stderr }).question('?');`);

rule.invalid('rejects an interface made through an aliased import of createInterface', `import { createInterface as lineReader } from 'node:readline';
export const read = (stream: NodeJS.ReadableStream) => lineReader({ input: stream }).on('line', () => {});`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects an interface made with new readline.Interface', `import readline from 'node:readline';
export const read = (stream: NodeJS.ReadableStream) => new readline.Interface({ input: stream }).on('line', () => {});`);

rule.invalid('rejects an interface in one block whose name an interface in another block handles', `import { createInterface } from 'node:readline';
export const read = (stream: NodeJS.ReadableStream, other: boolean) => {
  if (other) {
    const lines = createInterface({ input: stream });
    lines.on('line', () => {});
  } else {
    const lines = createInterface({ input: stream });
    lines.on('error', () => {});
  }
};`);

rule.invalid('rejects an interface whose name only a parameter of the same name in an inner function handles', `import { createInterface } from 'node:readline';
export const read = (stream: NodeJS.ReadableStream) => {
  const lines = createInterface({ input: stream });
  const guard = (lines: NodeJS.EventEmitter) => lines.on('error', () => {});
  return guard;
};`);

rule.invalid('rejects the second interface a variable takes after the first one got its error listener', `import { createInterface } from 'node:readline';
export const read = (stream: NodeJS.ReadableStream, next: NodeJS.ReadableStream) => {
  let lines = createInterface({ input: stream });
  lines.on('error', () => {});
  lines = createInterface({ input: next });
  lines.on('line', () => {});
};`);

rule.valid('allows an interface made through an aliased import that listens for errors', `import { createInterface as lineReader } from 'node:readline';
export const read = (stream: NodeJS.ReadableStream) => {
  const lines = lineReader({ input: stream });
  lines.on('error', () => {});
};`);

rule.valid('allows each interface a variable takes when each gets its error listener', `import { createInterface } from 'node:readline';
export const read = (stream: NodeJS.ReadableStream, next: NodeJS.ReadableStream) => {
  let lines = createInterface({ input: stream });
  lines.on('error', () => {});
  lines = createInterface({ input: next });
  lines.on('error', () => {});
};`);
