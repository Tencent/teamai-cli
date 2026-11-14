/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { Provider } from './provider.js';

type Copy = Extract<Provider, { family: 'copy' }>;

type Bind = Extract<Provider, { family: 'bind' }>;

/** Each provider says which family it is. */
export const families: Array<Provider['family']> = ['bind', 'copy'];

/** A copy provider is one only with the way it copies an attempt's work back. */
export const copies = (provider: Copy): Provider => provider;

// @ts-expect-error a copy provider cannot leave out how it copies the work back, which would lose the work
export const uncollected = (provider: Omit<Copy, 'collect'>): Provider => provider;

/** A bind provider's work is at its host paths already. */
export const binds = (provider: Bind): Provider => provider;

// @ts-expect-error a bind provider has nothing to copy back, so it cannot say it does
export const bindCollects = (provider: Omit<Bind, 'collect'> & { collect: Copy['collect'] }): Provider => provider;
