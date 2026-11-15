import { describeFamily } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

describeFamily('tool-dsh', family, {
  calls: {},
  transcripts: {},
  tokens: {},
  versions: { dsh: { command: 'dsh', stdout: 'v0.1.1 (3f9c2e1)', version: '0.1.1' } },
});
