import { describeFamily } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

describeFamily('tool-zcode', family, {
  calls: {},
  transcripts: {
    zcode: { unrecorded: 'ZCode joins each rollout JSONL to metadata in db.sqlite; session-adapter.test.ts covers that join through a stand-in sqlite3' },
  },
  tokens: {},
  versions: {},
});
