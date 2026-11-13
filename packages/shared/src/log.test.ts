import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spinner } from './log.js';

/** What a terminal has that ora reads or calls to draw and clear its line. */
const TERMINAL = ['isTTY', 'columns', 'cursorTo', 'moveCursor', 'clearLine'] as const;
const tty = Object.fromEntries(TERMINAL.map((key) => [key, Object.getOwnPropertyDescriptor(process.stderr, key)]));

/** process.stderr as a terminal `columns` wide, whose cursor moves nowhere. */
function terminalOf(columns: number): void {
  const moves = (): boolean => true;
  const values = { isTTY: true, columns, cursorTo: moves, moveCursor: moves, clearLine: moves };
  for (const key of TERMINAL) Object.defineProperty(process.stderr, key, { value: values[key], configurable: true, writable: true });
}

beforeEach(() => {
  // ora spins only where the stream is interactive: a terminal, outside CI, not TERM=dumb.
  vi.stubEnv('TERM', 'xterm-256color');
  vi.stubEnv('CI', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of TERMINAL) {
    const own = tty[key];
    if (own === undefined) Reflect.deleteProperty(process.stderr, key);
    else Object.defineProperty(process.stderr, key, own);
  }
});

it('draws no spinner on a terminal that reports no width, where clearing its line would never end', async () => {
  terminalOf(0);
  const pulling = (await spinner('Pulling')).start();

  try {
    expect(pulling.isSpinning).toBe(false);
  } finally {
    pulling.stop();
  }
});

it('draws the spinner on a terminal with a width', async () => {
  terminalOf(120);
  const pulling = (await spinner('Pulling')).start();

  try {
    expect(pulling.isSpinning).toBe(true);
  } finally {
    pulling.stop();
  }
});
