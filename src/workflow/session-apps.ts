/**
 * The apps a coding agent runs in whose sessions start a workflow on the app's own driver: what in a session's
 * environment says it runs in one, the driver whose runtime runs prompt steps there, where the person runs a start an
 * agent may not, and where the steps of a run appear.
 */
export const SESSION_APPS = [
  // First: a Paseo daemon started from a T3 thread's terminal gives its agents that thread's variable too.
  { variable: 'PASEO_AGENT_ID', driver: 'paseo', terminal: 'a terminal on this machine', steps: "Each prompt step appears in Paseo as an agent of its own, except a step that resumes the session of an earlier step in the same workspace on the same tool (session: continue or session: { from }), which goes on in that step's agent while Paseo still has it." },
  { variable: 'T3CODE_THREAD_ID', driver: 't3', terminal: 'this thread\'s T3 terminal', steps: "Each prompt step appears in T3 Code as a thread under this thread, except a step that resumes the session of an earlier step in the same workspace on the same tool (session: continue or session: { from }), which goes on in that step's thread while T3 Code still has it." },
] as const;

export type SessionApp = (typeof SESSION_APPS)[number];

/** The app whose session `env` is, when it is one's. */
export function sessionAppOf(env: NodeJS.ProcessEnv): SessionApp | undefined {
  return SESSION_APPS.find((app) => (env[app.variable] ?? '') !== '');
}
