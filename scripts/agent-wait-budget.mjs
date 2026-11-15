import { register } from 'node:module';

register('./typescript-loader.mjs', import.meta.url);

const { main } = await import('./agent-wait-budget.ts');

process.exitCode = await main(process.argv.slice(2));
