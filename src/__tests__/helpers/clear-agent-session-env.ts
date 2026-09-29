import { AGENT_SESSION_ENV, BRIDGE_AGENT_ENV } from '../../utils/session-id.js';

// Tests run inside an agent's shell (Claude Code sets CLAUDE_CODE_SESSION_ID),
// and recall, contribute and session save read that id through
// agentSessionIdFromEnv; a test that does not isolate HOME would also write
// that live session's state into the real ~/.teamai. Start every test file,
// and the CLIs it spawns, with none set, and without the bridge markers that
// would hide them (Pi or OpenCode shells).
for (const name of [...AGENT_SESSION_ENV, ...BRIDGE_AGENT_ENV]) {
  delete process.env[name];
}
