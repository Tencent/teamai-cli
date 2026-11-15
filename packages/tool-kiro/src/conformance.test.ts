import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

describeFamily('tool-kiro', family, {
  // `kiro-cli chat --no-interactive` prints the reply alone, and nothing when the call fails.
  calls: { kiro: { answered: { stdout: fixture('kiro-chat-answered.txt'), text: 'It uses Vitest.' }, failed: { stdout: fixture('kiro-chat-failed.txt') } } },
  transcripts: {},
  tokens: {},
  versions: {},
});
