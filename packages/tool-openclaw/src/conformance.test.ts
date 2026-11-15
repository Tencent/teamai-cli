import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

describeFamily('tool-openclaw', family, {
  calls: {
    openclaw: {
      answered: { stdout: fixture('openclaw-exec-answered.json'), text: 'It uses Vitest.' },
      failed: { stdout: fixture('openclaw-exec-failed.json'), message: 'No model configured: run `openclaw configure` first.' },
    },
  },
  transcripts: {},
  tokens: {},
  versions: { openclaw: { command: 'openclaw', stdout: '2026.10.2 (a1b2c3d)', version: '2026.10.2' } },
});
