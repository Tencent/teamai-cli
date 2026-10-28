/**
 * The skill driver's state machine. Each row function takes the input of one kind and returns the row it took with
 * only what its caller needs: the new state and the effects the shell applies, or the error the call answers. The rows
 * are the tables under `## The skill driver` in docs/dev/workflow-engine.md, cell by cell.
 */
import type { RunMode } from '../../../launch-context.js';
import type { ToolId } from '../../../types.js';
import type { Judging, RunReadied, RunVersion } from '../../protocol.js';
import type { EnvScope } from '../../requirements.js';
import type { AttemptId, RunId } from '../../store.js';
import type { WorkflowFailure } from '../../types.js';
import type { ChildResult } from './child-brief.js';
import type { HostChoice, HostProfile } from './host-profiles.js';
import type { HitlMode, StartAnswer, StartCheck } from './preflight.js';
import type { AttemptState, Dispatch, Gate, Judge, PlaceAsk, ReportBody, SkillState, StopReason, TurnEvent, UnansweredHost } from './skill-state.js';
import type { Waiting } from './turn.js';

export interface TransitionRow {
  id: string;
  state: string;
  input: string;
  guard: string;
  effects: string;
  next: string;
  action: string;
}

export const TRANSITIONS = [
  { id: 'R1', state: 'none', input: 'describe', guard: '`invoke: deny` and the caller has agent evidence', effects: 'none', next: 'none', action: 'describe `ask.kind: denied` with the reason, no literal' },
  { id: 'R2', state: 'none', input: 'describe', guard: 'run mode `attended`, and the definition has a local route: a step this driver takes and a later one it is held from for env or tokens work in one workspace copy', effects: 'none', next: 'none', action: 'describe `ask.kind: local` with the reason and the `--driver local` start literal, with `--tools default=<session tool>` when `localPromptTool` names one' },
  { id: 'R3', state: 'none', input: 'describe', guard: 'R27 does not apply, and something to ask: `invoke: ask`, a required input, width above 1, an optional gate, or judging here or by the session', effects: 'none', next: 'none', action: 'describe `ask.kind: ask`: one question stating every fact, and at most five start literals, the recommended first' },
  { id: 'R4', state: 'none', input: 'describe', guard: 'R27 does not apply, and nothing to ask', effects: 'none', next: 'none', action: 'describe `ask.kind: start` with the one start literal, and the facts to tell the person' },
  { id: 'R16', state: 'none', input: 'describe', guard: '`deliveryProblem` answers for the checkout: a `deliver: pr` step the definition cannot deliver (`bad_delivery`), or a detached HEAD (`no_base_branch`)', effects: 'none', next: 'none', action: 'describe `ask.kind: denied` with its message, no literal' },
  { id: 'R23', state: 'none', input: 'describe', guard: 'run mode `unattended`, R1 and R16 do not apply, and the definition has a local route, as R2\'s', effects: 'none', next: 'none', action: 'describe `ask.kind: denied` with the local route\'s reason, no literal: nobody is there to run the local driver' },
  { id: 'R17', state: 'none', input: 'describe', guard: 'run mode `unattended`, R1, R16 and R23 do not apply, and `attendedReason` names what needs a person: `invoke: ask`, an interactive step, a required approval, or a choice without a default', effects: 'none', next: 'none', action: 'describe `ask.kind: denied` with that reason, no literal' },
  { id: 'R18', state: 'none', input: 'describe', guard: 'run mode `unattended`, and R1, R16, R23, R17 and R27 do not apply', effects: 'none', next: 'none', action: 'describe `ask.kind: start` with the start of R3\'s recommended option under `--auto-approve`; `{inputs}` kept and `inputs` listed when the workflow has inputs' },
  { id: 'R27', state: 'none', input: 'describe', guard: 'the session names no tool, the definition has a step whose model or judging needs one (`needsTool`), and R1, R16, R2, R23 and R17 do not apply', effects: 'none', next: 'none', action: 'describe `ask.kind: tool` with the reason, the describe literal with `--tools default=\'{tool}\'` for the agent to fill, and the ids of the tools teamai knows' },
  { id: 'R8', state: 'none', input: 'start `--driver skill`, or R19\'s input', guard: 'the definition has a local route; for R19\'s input, the run\'s own definition, once R20 and R21 do not apply, or, in run mode `unattended`, as the run stands before the claim', effects: 'none', next: 'none', action: 'error `needs_local_driver` with the reason, next null; for R19\'s input it names the person\'s `teamai workflow resume <run>` literal, and the run stays readied here, or, unattended, as it was: nothing is claimed' },
  { id: 'R25', state: 'none', input: 'start `--driver skill`', guard: 'run mode `unattended`, R8 does not apply, and `attendedReason` names what needs a person, as R17\'s', effects: 'none', next: 'none', action: 'error `unattended_denied` with that reason, next null: no run is created' },
  { id: 'R9', state: 'none', input: 'start `--driver skill`', guard: '`checkStartAnswers` answers `confirm-needed`, and R8 and R25 do not apply', effects: 'none', next: 'none', action: 'error `confirm_needed`, next: the describe literal' },
  { id: 'R10', state: 'none', input: 'start `--driver skill`', guard: '`checkStartAnswers` answers `ok`', effects: '`WorkflowClient.start`; write skill.json: identity `{skill, machine, run checkout}`, invocation, options (`--parallel`, the HITL mode, the caller\'s run mode), host `pending` when the definition has a prompt step or the session judges the run, with whether it has a prompt step, owner := the caller\'s session, working in the tool its `--tools default=<tool>` names, else the one its host names; judging on with the session tool when describe judges here, or `sessionJudge` with it when describe judges by the session, and the start has no `--no-judge`', next: 'host when it has a prompt step or the session judges it, else drive', action: 'the turn of a tick' },
  { id: 'R11', state: 'none', input: 'next, report `--driver skill`', guard: 'this machine has no skill.json for the run', effects: 'none', next: 'none', action: 'error `not_skill_run`, next: the `resume <run> --driver skill` literal, with `--tools default=\'{tool}\'` for a session with no tool to fill' },
  { id: 'R28', state: 'any', input: 'R19\'s input', guard: 'R19 would take the run, R8 and R24 do not apply, and the session names no tool while the run has a step whose model or judging needs one (`needsTool`)', effects: 'remove the skill.json kept here, which the published run the resume installed made stale', next: 'unchanged', action: 'error `tool_needed`, next: the `resume <run> --driver skill --tools default=\'{tool}\'` literal with the options and `--confirmed` of the call, whose slot the agent fills with its tool' },
  { id: 'R19', state: 'any', input: 'resume `--driver skill`; `next --takeover` with no skill.json here', guard: '`WorkflowClient.resume` readied the run: it took a run this machine lacks, or with `--claim` one another install owns, or found the run here and this install its owner, and released each lease this machine\'s local driver left on it, once the process group that lease\'s setup or command left is stopped, and stopped the group each attempt of that driver the run already stopped left; no skill.json is kept here, or the claim installed the published state; R8, R24 and R28 do not apply', effects: 'write skill.json as R10 does, with the caller\'s run mode and the options of `--parallel`, `--hitl` or `--auto-approve` and `--no-judge`, else a start\'s: one step at a time, HITL mode `person`, or `auto-approve` in an unattended run', next: 'host when the run has a prompt step or the session judges it, else drive', action: 'the turn of a tick' },
  { id: 'R20', state: 'any', input: 'R19\'s input', guard: '`WorkflowClient.resume` answers that another install owns the run (a resume without `--claim`, or a takeover), or that this machine lacks it (a takeover)', effects: 'none', next: 'unchanged', action: 'error `not_owner` or `run_not_found`, next: the `resume <run> --driver skill --claim` literal, with the `--tools default=<tool>` the resume declared, run only when the person agrees' },
  { id: 'R21', state: 'any', input: 'R19\'s input', guard: '`WorkflowClient.resume` refuses the run otherwise: teamai-reports does not hold it or moved while it was claimed, its definition cannot be read here, or its copies cannot be brought to the commits it recorded', effects: 'none', next: 'unchanged', action: 'error with the refusal\'s code and message, next null' },
  { id: 'R22', state: 'any', input: 'resume `--driver skill`, `next --takeover`', guard: 'the caller is not the session skill.json here names as the run\'s owner, and `WorkflowClient.resumeRefusal` refuses it by the `invoke` of the run\'s own definition, as a start is refused: agent evidence (a session variable, or `--driver skill` itself), and `invoke: deny`, or `invoke: ask` without `--confirmed` or in an unattended run', effects: 'none', next: 'unchanged', action: 'error `invoke_denied`, `unattended_denied` or `confirm_needed`; next: for `confirm_needed` the same call with `--confirmed`, run only when the person agrees, else null' },
  { id: 'R24', state: 'any', input: 'R19\'s input, or `next --takeover` with skill.json here', guard: 'run mode `unattended`, R8 does not apply, and `attendedReason` names what in the run\'s own definition needs a person, as R17\'s, counting only the steps the run has not settled for good (succeeded or skipped, a step in `for_each` items once every item settled it or a step that holds it, and every step in a workflow or `for_each` step that settled whole; none while a workflow or step loop of the run could run them again), and its `invoke: ask`; read before the claim or the takeover, from the published run a `--claim` would install, else this machine\'s copy, so R20 and R21 come after it', effects: 'none', next: 'unchanged', action: 'error `unattended_denied` with that reason, next null; the run and its skill state stay as they were: nothing is claimed or taken over' },
  { id: 'R26', state: 'any', input: 'R24\'s input, with skill.json here that R19 does not replace', guard: 'run mode `unattended`, R8 and R24 do not apply, and the skill.json\'s run mode is `attended`', effects: 'its run mode becomes `unattended`, and its HITL mode that of `--hitl` or `--auto-approve`, else `auto-approve`', next: 'unchanged', action: 'the S row of the call' },
  { id: 'R12', state: 'host', input: 'tick', guard: '', effects: 'none', next: 'host', action: '`choose about:host decide:agent`' },
  { id: 'R13', state: 'host', input: 'next `--choice h`', guard: '', effects: 'host := `HOST_PROFILES[h]`, or `none` for a run without a prompt step, which asked it only for its judge; on `h4`, which starts no child agent, drop `sessionJudge`', next: 'drive', action: 'the turn of a tick, with event `judging-off` `no_child_agent` when it dropped `sessionJudge`' },
  { id: 'R14', state: 'host', input: 'report, next `--ack` or `--adopt`', guard: '', effects: 'none', next: 'host', action: 'error `choice_pending`, next: the next literal' },
  { id: 'R15', state: 'drive, done', input: 'next `--choice h`', guard: '', effects: 'none', next: 'unchanged', action: 'error `unknown_choice`, next: the next literal' },
  { id: 'S1', state: 'host, drive, done', input: 'an agent call from session s', guard: 'the owner is s, or either session is unknown', effects: '`lastCallAt` := now; the tool := the one the call declares with `--tools`; else owner := s, working in s\'s tool, when unknown; else the tool := s\'s when the run has none and s is its owner or neither is known', next: 'unchanged', action: 'the input\'s row' },
  { id: 'S2', state: 'host, drive, done', input: 'an agent call from session s without `--takeover`', guard: 'owner o is not s, and both are known, however long o has been idle', effects: 'none', next: 'unchanged', action: 'error `orchestrator_active` with `idleSeconds`, the seconds since o\'s last call, next: the takeover literal' },
  { id: 'S4', state: 'host, drive, done', input: 'next `--takeover` from session s', guard: '', effects: 'owner := s, working in the tool its host names; `lastCallAt` := now; `seen[s]` := `seen[o]` when that is later; every offered or dispatched attempt becomes offered with `reissued`', next: 'unchanged', action: 'event `takeover`; the turn of a tick' },
  { id: 'S5', state: 'any', input: 'a runner call (`report --attempt a` with the marker `<run>/a`)', guard: '', effects: 'no session check, no `lastCallAt`', next: 'unchanged', action: 'C rows' },
  { id: 'S6', state: 'host, drive, done', input: 'an agent `report --attempt a`, from any session', guard: 'a is settled, or open offered, dispatched, reporting, or stopping by the agent', effects: 'no session check, no `lastCallAt`', next: 'unchanged', action: 'the input\'s row' },
  { id: 'D1', state: 'drive', input: 'tick', guard: '', effects: 'engine `next {driver: identity + canFor(host), the can of the host\'s profile, and h1\'s for a run without prompt steps, running: every open attempt, canTakeLease: fewer open than options.parallel, and than one under a serial host; false in a runner\'s check, autoApprove: true under HITL mode `auto-approve`, runMode: options.mode}`', next: 'drive', action: '' },
  { id: 'D2', state: 'drive', input: 'reply `cancelled` holds a', guard: 'a queued or placing', effects: 'drop a', next: 'drive', action: 'event `stopped`' },
  { id: 'D3', state: 'drive', input: 'reply `cancelled` holds a', guard: 'a preparing or running', effects: 'phase stopping by its runner, why `timeout` once its `expiresAt` passed, else `cancelled`', next: 'drive', action: '' },
  { id: 'D4', state: 'drive', input: 'reply `cancelled` holds a', guard: 'a offered or dispatched', effects: 'phase stopping by the agent, why as D3', next: 'drive', action: '`stop {why, report}` in each foreground turn until reported' },
  { id: 'D5', state: 'drive', input: 'reply `cancelled` holds a', guard: 'a stopping or reporting', effects: 'none', next: 'drive', action: '' },
  { id: 'D6', state: 'drive', input: 'reply lease', guard: 'executor command', effects: 'phase preparing; spawn runner job `command`', next: 'drive', action: 'event `started`' },
  { id: 'D7', state: 'drive', input: 'reply lease', guard: 'executor prompt, and D8 does not apply', effects: 'phase preparing; spawn runner job `prompt`', next: 'drive', action: 'event `started`' },
  { id: 'D8', state: 'drive', input: 'reply lease', guard: 'executor prompt, workspace `new` or `continue`, and a host that makes places (h3)', effects: 'phase preparing with request `host`; spawn runner job `prompt`', next: 'drive', action: 'event `started`' },
  { id: 'D9', state: 'drive', input: 'tick', guard: 'a queued attempt whose `behind` is no longer open', effects: 'phase preparing; spawn its job again', next: 'drive', action: '' },
  { id: 'D10', state: 'drive', input: 'reply hitl', guard: 'a required approval', effects: 'journal the gate: `seq` := seq + 1, unless it is the gate journalled already', next: 'drive', action: '`person why:approval` with the person\'s literals; waiting `<step> waits for the person\'s answer`' },
  { id: 'D11', state: 'drive', input: 'reply hitl', guard: 'an optional gate; HITL mode `person`, or `auto-approve`, under which only a choice without a default comes back', effects: 'as D10', next: 'drive', action: '`choose about:gate decide:person`' },
  { id: 'D12', state: 'drive', input: 'reply hitl', guard: 'an optional gate; HITL mode `recommend`', effects: 'as D10', next: 'drive', action: '`choose about:gate decide:agent`' },
  { id: 'D13', state: 'drive', input: 'reply wait', guard: 'it lists `delivering`', effects: 'none', next: 'drive', action: 'waiting `delivering` in each turn that ticked, polls\' included; `then: poll`' },
  { id: 'D14', state: 'drive', input: 'reply wait', guard: 'it lists `held`, and no attempt is open', effects: 'none', next: 'drive', action: '`person why:handoff` with the person\'s `teamai workflow resume <run>` literal, with `--tools default=<session tool>` when `localPromptTool` names one; waiting `held`; no `then`' },
  { id: 'D15', state: 'drive', input: 'reply wait', guard: '', effects: 'none', next: 'drive', action: 'waiting' },
  { id: 'D27', state: 'drive', input: 'reply wait, after its row', guard: 'it lists `held`, and no reply of this tick came to a `next` that took no lease', effects: 'engine `next` as D1, with `canTakeLease: false`, since the engine answers a held step before a gate; H5, then D10 to D12 for a gate, take its reply', next: 'drive', action: '' },
  { id: 'D16', state: 'drive', input: 'reply done', guard: '', effects: '`seq` := seq + 1, so every session has the end to see; keep with the end the run file\'s version, read after, when the end is out and its status and receipts agree with the end', next: 'done', action: '`done {outcome, failure, prs, judging, score}`' },
  { id: 'D17', state: 'drive', input: 'reply error', guard: '', effects: 'none', next: 'drive', action: 'error with the engine\'s code, next: the next literal' },
  { id: 'D18', state: 'drive', input: 'a foreground call', guard: 'it spawned runners', effects: 'release the lock; wait up to `WAIT_GRACE_MS` for them, re-taking the lock per check', next: 'drive', action: '' },
  { id: 'D19', state: 'any', input: 'a foreground call', guard: 'the lock is not free within `TICK_LOCK_WAIT_MS` (`report`: `WAIT_BOUND_MS`)', effects: 'none', next: 'unchanged', action: 'error `driver_running`, next: the same literal' },
  { id: 'D20', state: 'host, drive, done', input: 'a foreground call, after its tick', guard: '', effects: '`seen[s]` := seq', next: 'unchanged', action: 'the turn: the host question, or every `stop`, then every unacked dispatch, then every `place`, then the gate\'s `choose` or `person`; events after the old `seen[s]`; `then: poll` until the run is done and no attempt or judge is open' },
  { id: 'D21', state: 'host, drive, done', input: 'a poll tick', guard: 'the lock was busy, or nothing below applies, and the bound is not reached', effects: 'release; sleep `WAIT_POLL_MS`; tick again', next: 'unchanged', action: '' },
  { id: 'D22', state: 'host, drive, done', input: 'a poll tick', guard: 'the host question is unanswered, a dispatch is unacked, a place is not adopted, a `stop` is not reported, or the gate was journalled after `seen[s]`', effects: 'none', next: 'unchanged', action: '`then: wake` with the next literal, no actions' },
  { id: 'D23', state: 'done', input: 'a poll tick', guard: '`seen[s]` is below seq, and no attempt is open', effects: '`seen[s]` := seq', next: 'done', action: '`done` with its events; `then: poll` while a judge is open' },
  { id: 'D24', state: 'host, drive, done', input: 'a poll tick', guard: 'the bound is reached, and D25 does not apply', effects: 'none', next: 'unchanged', action: '`then: poll`, no actions' },
  { id: 'D25', state: 'drive, done', input: 'a poll tick', guard: 'a `settled` or `stopped` event came after `seen[s]`, and neither D22 nor D23 applies', effects: '`seen[s]` := seq', next: 'unchanged', action: 'the events after the old `seen[s]`, no actions; `then: poll`' },
  { id: 'D26', state: 'drive', input: 'a poll tick', guard: 'the tick took D14, and D22 does not apply', effects: 'none', next: 'drive', action: '`then: wake` with the next literal, no actions' },
  { id: 'C1', state: 'preparing', input: 'runner: prepared', guard: 'job `command`', effects: 'run the command outside the lock with `{...stepEnvironment(values, envScope).env, ...lease.env, TEAMAI_WORKFLOW_ATTEMPT}` (`process.env` for a lease without `envScope`), output masked into `output.log`', next: 'running', action: '' },
  { id: 'C2', state: 'preparing', input: 'runner: prepared', guard: 'job `prompt`', effects: '`pickChildModel`; `writeChildBrief`', next: 'offered', action: '`dispatch` in each foreground turn until acked' },
  { id: 'C3', state: 'preparing', input: 'runner: prepared', guard: 'job `prompt`; `pickChildModel` fails `model_unavailable`', effects: 'write-ahead `failed` with that failure', next: 'reporting', action: '' },
  { id: 'C4', state: 'preparing', input: 'runner: place busy, behind b', guard: '', effects: '`behind` := b', next: 'queued', action: '' },
  { id: 'C5', state: 'preparing', input: 'runner: needs a place', guard: 'request `host`, and no place an earlier attempt adopted for the branch passes the adopt checks', effects: 'the place to ask for: `name`, `branch`, `start`', next: 'placing', action: '`place` in each foreground turn until adopted' },
  { id: 'C6', state: 'preparing', input: 'runner: adopt refused', guard: 'request `adopt dir`', effects: '`refused` := why; the engine still leases a', next: 'placing', action: '`place` with `refused`' },
  { id: 'C7', state: 'preparing', input: 'runner: prepare or setup failed', guard: '', effects: 'write-ahead `failed` with its failure', next: 'reporting', action: '' },
  { id: 'C8', state: 'running', input: 'runner: the command exited', guard: '', effects: 'write-ahead: `success` on exit 0, else `failed`; outputs, exit code, masked tail', next: 'reporting', action: '' },
  { id: 'C9', state: 'stopping by its runner', input: 'runner: its check every `RUNNER_POLL_MS` and at `expiresAt`, its setup ending, or its command exiting', guard: '', effects: 'stop the setup or command and every process it started (`tool-launch/process-stop.ts`); write-ahead `released`', next: 'reporting', action: '' },
  { id: 'C10', state: 'preparing, running', input: 'tick: its `runner.lock` is free', guard: 'it was spawned more than `WAIT_GRACE_MS` ago', effects: 'stop the process group its setup or command left; spawn the same job again (prepare is idempotent; a command restarts in its prepared place)', next: 'unchanged', action: 'event `restarted`' },
  { id: 'C11', state: 'stopping by its runner', input: 'tick: its `runner.lock` is free', guard: 'it was spawned more than `WAIT_GRACE_MS` ago', effects: 'stop the process group its setup or command left; write-ahead `released`', next: 'reporting', action: '' },
  { id: 'K1', state: 'drive', input: 'next `--ack dispatch.a`', guard: 'a offered', effects: 'phase dispatched', next: 'drive', action: 'the turn of a tick' },
  { id: 'K2', state: 'drive', input: 'next `--ack dispatch.a`', guard: 'a dispatched', effects: 'none', next: 'drive', action: 'the turn of a tick' },
  { id: 'K3', state: 'drive, done', input: 'next `--ack dispatch.a`', guard: 'a neither offered nor dispatched', effects: 'none', next: 'unchanged', action: 'error `unknown_offer`, next: the next literal' },
  { id: 'K4', state: 'drive', input: 'next `--attempt a --adopt dir`', guard: 'a placing', effects: 'phase preparing with request `adopt dir`; spawn its job again', next: 'drive', action: 'the turn of a tick' },
  { id: 'K5', state: 'drive, done', input: 'next `--attempt a --adopt dir`', guard: 'a not placing', effects: 'none', next: 'unchanged', action: 'error `unknown_attempt`, next: the next literal' },
  { id: 'P1', state: 'drive, done', input: 'report a', guard: 'a is in the settled list', effects: 'none', next: 'unchanged', action: 'runner answer `repeated`' },
  { id: 'P2', state: 'drive', input: 'report a', guard: 'a is unknown', effects: 'none', next: 'drive', action: 'error `unknown_attempt`, next: the next literal' },
  { id: 'P3', state: 'drive', input: 'report a', guard: 'a preparing, queued, placing, running, or stopping by its runner', effects: 'none', next: 'drive', action: 'error `not_dispatched`, next: the next literal' },
  { id: 'P4', state: 'drive', input: 'report a `--model-unavailable`', guard: 'a offered or dispatched, its dispatch printed `unavailable`', effects: 'write-ahead `failed` `model_unavailable` naming the model', next: 'reporting', action: 'P7 to P10; after P7 to P9, runner answer `reported`' },
  { id: 'P5', state: 'drive', input: 'report a', guard: 'a offered or dispatched, otherwise', effects: 'read `result.json`: an output gives `success` with it as outputs, a failure gives `failed` with it, none or an unreadable one gives `failed` `tool_failed`; write-ahead', next: 'reporting', action: 'P7 to P10; after P7 to P9, runner answer `reported`' },
  { id: 'P6', state: 'drive, done', input: 'report a', guard: 'a stopping by the agent', effects: 'write-ahead `released`', next: 'reporting', action: 'P7 to P10; after P7 to P9, runner answer `reported`' },
  { id: 'P7', state: 'reporting', input: 'engine: reported, any status', guard: '', effects: 'drop a; add to settled', next: 'drive', action: 'event `settled`, with the failure the engine recorded, else the body\'s' },
  { id: 'P8', state: 'reporting', input: 'engine: `repeated_report`', guard: '', effects: 'as P7', next: 'drive', action: 'event `settled`' },
  { id: 'P9', state: 'reporting', input: 'engine: `lease_cancelled`', guard: '', effects: 'drop a (the protocol abandoned its place); add to settled, so a late report of its child is P1', next: 'unchanged', action: 'event `stopped`, why as its stop said, else as D3' },
  { id: 'P10', state: 'reporting', input: 'engine: another error', guard: '', effects: 'keep the body', next: 'reporting', action: 'error, next: the same report literal (a runner retries at its next check)' },
  { id: 'P11', state: 'reporting', input: 'tick, or report a', guard: 'a body is stored (a crash or a refusal came between write and send)', effects: 'send it again', next: 'reporting', action: 'P7 to P10' },
  { id: 'H1', state: 'drive', input: 'respond `--driver skill`', guard: 'the engine answers `repeated_response`: the gate was answered already', effects: 'none', next: 'drive', action: 'the turn of a tick' },
  { id: 'H2', state: 'drive', input: 'respond `--driver skill`', guard: 'the engine recorded the answer, as an agent\'s', effects: 'clear the gate when it is the one answered', next: 'drive', action: 'event `answered`; the turn of a tick' },
  { id: 'H3', state: 'drive', input: 'respond `--driver skill`', guard: 'the engine answers `agent_in_path`: a required approval', effects: 'none', next: 'drive', action: 'error `agent_in_path`, next: the poll literal' },
  { id: 'H4', state: 'drive', input: 'respond `--driver skill`', guard: 'the engine answers another error', effects: 'none', next: 'drive', action: 'error with the engine\'s code, next: the next literal' },
  { id: 'H5', state: 'drive', input: 'reply, before its row', guard: 'a gate is journalled, and the reply is done, a wait that holds nothing, or another gate: the person answered it in their terminal or the dashboard', effects: 'clear the gate', next: 'drive', action: '' },
  { id: 'J1', state: 'drive, done', input: 'tick', guard: 'judging is on', effects: '`score --next {driver: identity + can.judge of the session tool, run, running: the open judge ref, canTakeLease: no judge open; false in a runner\'s check}`', next: 'unchanged', action: '' },
  { id: 'J2', state: 'drive, done', input: 'score reply: a lease', guard: 'judging is on, and no judge is open', effects: 'the judge is open; spawn its runner, keyed by the attempt in its ref', next: 'unchanged', action: 'event `judging`' },
  { id: 'J3', state: 'drive, done', input: 'judge runner: labelled', guard: 'its judge is open', effects: 'drop the judge', next: 'unchanged', action: 'event `judged` per scorer' },
  { id: 'J4', state: 'drive, done', input: 'judge runner: failed', guard: 'its judge is open', effects: 'judging := off; its lease lapses back to the queue', next: 'unchanged', action: 'event `judging-off` with the failure' },
  { id: 'J5', state: 'drive, done', input: 'tick: the open judge\'s `runner.lock` is free', guard: 'it was spawned more than `WAIT_GRACE_MS` ago', effects: 'stop the process group its judge left; judging := off; its lease lapses back to the queue', next: 'unchanged', action: 'event `judging-off` `judge_runner_gone`' },
  { id: 'J6', state: 'drive, done', input: 'score reply: an error', guard: 'the error is not `busy`', effects: 'judging := off', next: 'unchanged', action: 'event `judging-off` with the error' },
  { id: 'X1', state: 'done', input: 'next', guard: 'no attempt is open, and a judge is', effects: 'none', next: 'done', action: '`done` with `judging`; `then: poll`' },
  { id: 'X2', state: 'done', input: 'next', guard: 'no attempt or judge is open', effects: 'none', next: 'done', action: '`done`, no `then`' },
  { id: 'X4', state: 'done', input: 'next', guard: 'an attempt is still open: the engine cancelled it with the run', effects: 'none', next: 'done', action: 'every `stop`, then `done`; `then: poll`' },
  { id: 'X5', state: 'done', input: 'tick', guard: 'the run file shows a version other than the one kept with the end, or a create still unresolved, or none was kept', effects: 'keep the run file\'s version with the end; engine `next` as D1, with `canTakeLease: false`', next: 'done', action: '' },
  { id: 'X6', state: 'done', input: 'reply, before its row', guard: 'the reply is not `done`, or is a `done` whose outcome, failure or PRs differ from the kept end (`canonicalJson`), or that is not out: the engine reopened the run, as `workflow retry` does, another driver ended it again, or the end still has to reach `teamai-reports`', effects: 'drop `done`', next: 'drive', action: 'the reply\'s row; the tick goes on as in drive' },
  { id: 'X7', state: 'done', input: 'tick', guard: 'the run file shows the version kept with the end (status, revision, pull request receipts), and no create unresolved', effects: 'none: no engine `next`, so no tick publishes an end already out again', next: 'done', action: '' },
] as const satisfies readonly TransitionRow[];

export type RowId = typeof TRANSITIONS[number]['id'];

/** A lease the engine handed out, as the tick read it: a command, or a prompt for a child. */
export type ReadLease = { attempt: AttemptId; step: string; revision: number; expiresAt?: string } & (
  | { executor: 'command'; command: string; env: Record<string, string>; envScope?: EnvScope }
  /**
   * `writes`: the step commits to a branch, in a workspace `new` or `continue`. `interactive`: the person works in the step.
   * `readOnly`: the step set `workspace: read-only`. `isolation`: the step requires a sandbox, which no skill host enforces.
   */
  | { executor: 'prompt'; prompt: string; place: Dispatch['place']; writes: boolean; interactive?: true; readOnly?: true; isolation?: 'sandbox'; agent?: string; model?: string; defaultModel?: string; output?: unknown }
);

/** A gate as the engine asks it. */
export type AskedGate = Omit<Gate, 'seq' | 'decide'>;

export type EngineReply =
  /** `raw` is the lease as the engine sent it: its runner prepares the place from it. */
  | { kind: 'lease'; lease: ReadLease; raw: unknown }
  /**
   * `delivering`: steps whose pull requests are being opened. `held`: steps were ready, and the engine held them back
   * from this driver.
   */
  | { kind: 'wait'; reason: string; delivering: string[]; held: NonNullable<Waiting['held']> }
  | { kind: 'hitl'; gate: AskedGate }
  /** `out`: the end reached `teamai-reports`, or another install owns the run and publishes it. */
  | { kind: 'done'; outcome: NonNullable<SkillState['done']>['outcome']; failure?: WorkflowFailure; prs: string[]; out: boolean }
  | { kind: 'error'; error: WorkflowFailure };

/** What `score --next` answered: a lease, read as the judge it opens; nothing to take; or an error. */
export type ScoreReply = { kind: 'lease'; judge: Omit<Judge, 'spawnedAt'> } | { kind: 'idle' } | { kind: 'error'; error: WorkflowFailure };

/** What the engine answered the agent's answer to a gate: the answer it recorded, or an error. */
export type RespondReply = { kind: 'answered'; step: string; pass: number; choice: string; channel: string; agent: boolean } | { kind: 'error'; error: WorkflowFailure };

/** What the engine answered a sent report: the step it settled, with the failure it recorded, or an error. */
export type ReportReply = { kind: 'reported'; outcome: Extract<TurnEvent, { kind: 'settled' }>['outcome']; failure?: WorkflowFailure } | { kind: 'error'; error: WorkflowFailure };

/** What the open judge's runner learned: the label of each scorer, or why the judge gave none. */
export type JudgeAnswer = { kind: 'judged'; labels: Array<{ scorer: string; label: string }> } | { kind: 'failed'; failure: WorkflowFailure };

/**
 * What describe knows before the rows choose how to start. `denied`: why an agent session may not start the workflow.
 * `local`: why the local driver must run it. `judged`: the scored steps are judged on this machine, by the session
 * tool's confined judge or by the session itself, so the person may turn judging off. `undeliverable`: why a start from
 * the checkout would be refused for its delivery. `mode`: the run mode of the caller. `attended`: why a run of the
 * workflow needs a person. `needsTool`: the session names no tool, and the workflow has a step whose model or judging
 * needs one.
 */
export interface DescribeInput { needed: StartAnswer[]; denied?: string; undeliverable?: string; local?: string; judged: boolean; mode: RunMode; attended?: string; needsTool: boolean }

/** Who judges a run's scored steps on this machine: the confined judge of `tool` here, or the session itself with `tool`. */
export type JudgedBy = { kind: 'here'; tool: string } | { kind: 'session'; tool: string };

/** Who judges on this machine as `judging` says, so the person may turn judging off; undefined when nobody does. */
export function judgedBy(judging: Judging): JudgedBy | undefined {
  switch (judging.kind) {
    case 'here':
      return { kind: 'here', tool: judging.tool };
    case 'session':
      return { kind: 'session', tool: judging.tool };
    case 'none':
    case 'elsewhere':
      return undefined;
    default: {
      const unhandled: never = judging;
      return unhandled;
    }
  }
}

/** What a start knows before the rows decide it. `judge`: who judges the run on this machine, when describe found one and the start keeps judging. */
/** `attended`: what in the definition needs a person, in an unattended run, as `attendedReason` says. */
export interface StartInput { name: string; check: StartCheck; local?: string; attended?: string; prompts: boolean; judge?: JudgedBy }

/** What the shell does for a row, beyond saving its state. `applyEffects` applies each kind, in order. */
export type Effect =
  /** `job` is the lease of a new attempt; a respawn reuses the job already saved. */
  | { kind: 'spawn'; attempt: AttemptId; job?: { lease: unknown } }
  /** Stops what the command of `attempt` left running when its runner died, before anything else runs in its place. */
  | { kind: 'stop-left'; attempt: AttemptId }
  /** Saves the state, which holds `body` as the report of `attempt`, then sends it. */
  | { kind: 'send'; attempt: AttemptId; body: ReportBody };

/** A call the skill driver refuses, with what its message names. */
export type Refusal =
  /** `run`: the run a resume or a takeover readied here, which the person goes on with the local driver. */
  | { code: 'needs_local_driver'; name: string; reason: string; run?: RunId }
  | { code: 'confirm_needed'; name: string; missing: StartAnswer[]; outOfRange?: { parallel: number; ceiling: number } }
  | { code: 'not_skill_run'; run: RunId; toolNamed: boolean }
  | { code: 'tool_needed'; run: RunId; answers: ResumeAnswers; confirmed: boolean }
  /** Another teamai install, `owner`, has owned the run since `since`. */
  | { code: 'not_owner'; run: RunId; owner: string; since: string }
  /** A takeover of a run this machine lacks. */
  | { code: 'run_not_found'; run: RunId }
  /** `idleSeconds`: the seconds since the owner's last call. */
  | { code: 'orchestrator_active'; run: RunId; idleSeconds: number }
  | { code: 'choice_pending'; run: RunId }
  | { code: 'unknown_choice'; run: RunId }
  | { code: 'unknown_offer'; run: RunId; attempt: AttemptId }
  /** `phase`: the attempt is open, in that phase, and waits for no place. */
  | { code: 'unknown_attempt'; run: RunId; attempt: AttemptId; phase?: AttemptState['phase'] }
  | { code: 'not_dispatched'; run: RunId; attempt: AttemptId; phase: AttemptState['phase'] }
  | { code: 'driver_running'; run: RunId };

/**
 * How describe says to start, and why, for the kinds that start no run here. `unattended`: start with the recommended
 * answers and optional gates auto-approved, since nobody answers a question.
 */
export type DescribeVerdict = { ask: 'start' | 'ask' | 'unattended' | 'tool' } | { ask: 'local' | 'denied'; reason: string };

/** The run R10 starts: its options, whether it asks the host question first, and who judges it on this machine. */
export interface StartRun { parallel: number; hitl: HitlMode; host: UnansweredHost; judge?: JudgedBy }

/** A refusal of the skill driver; its code decides the literal it names to run instead. */
type Refused = { kind: 'error'; refusal: Refusal };
/** An engine error the skill driver relays, and the literal it names to run instead. */
type Relayed = { kind: 'engine-error'; error: WorkflowFailure; next: 'next' | 'same' | 'poll' | null };
/** The error a row answers the call with. */
export type Answer = Refused | Relayed;

/**
 * How the shell renders the turn a row decides: the events it shows, the call it shows `after` as the turn's `then`
 * (`none` leaves `then` out, which ends the agent's loop), and whether it is quiet, carrying no action.
 */
export interface TurnAnswer {
  kind: 'turn';
  events: 'unseen' | 'none';
  after: 'poll' | 'wake' | 'none';
  quiet: boolean;
}

/** A row that moves the run to `state`. */
export interface Moved<R extends RowId> {
  row: R;
  state: SkillState;
}

/** A row that moves the run to `state`, and the effects the shell applies for it. */
export interface MovedWithEffects<R extends RowId> extends Moved<R> {
  effects: Effect[];
}

/** A row that answers the call with an error, and leaves the run as it was. */
export interface Answered<R extends RowId, A extends Answer = Answer> {
  row: R;
  answer: A;
}

/** What a tick leaves for the turn of its call: why the run leases nothing more, and the turn a row of it decided. */
export interface TickTurn {
  waiting?: Waiting;
  turn?: TurnAnswer;
}

function withEvent(state: SkillState, event: TurnEvent): SkillState {
  const seq = state.seq + 1;
  return { ...state, seq, events: [...state.events, { seq, event }] };
}

/** `state` with `attempt` in the place it holds, or last when it is new, so a turn lists attempts in the order they opened. */
function withAttempt(state: SkillState, attempt: AttemptState): SkillState {
  const held = state.attempts.some((open) => open.attempt === attempt.attempt);
  return { ...state, attempts: held ? state.attempts.map((open) => (open.attempt === attempt.attempt ? attempt : open)) : [...state.attempts, attempt] };
}

/** The attempt `open` with only what every phase keeps. */
function baseOf(open: AttemptState): Pick<AttemptState, 'attempt' | 'step' | 'revision' | 'spawnedAt' | 'expiresAt'> {
  const { attempt, step: id, revision, spawnedAt, expiresAt } = open;
  return { attempt, step: id, revision, spawnedAt, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

/** Why the engine stopped `open`, as it is known at `at`: its deadline passed, or the person cancelled it. */
function stopReason(open: AttemptState, at: string): StopReason {
  return open.expiresAt !== undefined && Date.parse(open.expiresAt) <= Date.parse(at) ? 'timeout' : 'cancelled';
}

/** Gives up stopped attempt `open` with a `released` report, which the protocol answers by abandoning its place. */
function released<R extends 'C9' | 'C11' | 'P6'>(state: SkillState, open: Extract<AttemptState, { phase: 'stopping' }>, row: R): MovedWithEffects<R> {
  const body: ReportBody = { attempt: open.attempt, revision: open.revision, driver: state.driver, outcome: 'released' };
  return { row, state: withAttempt(state, { ...baseOf(open), phase: 'reporting', body, stopped: open.why }), effects: [{ kind: 'send', attempt: open.attempt, body }] };
}

/** Whether the agent reports `open`: its child works it, or the agent must stop that child. */
export function reportedByAgent(open: AttemptState): boolean {
  return open.phase === 'offered' || open.phase === 'dispatched' || (open.phase === 'stopping' && open.by === 'agent');
}

/** Whether something waits for the agent: the host question, a dispatch to ack, a place to adopt, or a child to stop. */
function waitsForAgent(state: SkillState): boolean {
  return state.host.kind === 'pending'
    || state.attempts.some((open) => open.phase === 'offered' || open.phase === 'placing' || (open.phase === 'stopping' && open.by === 'agent'));
}

/** Whether `gate` is the gate the engine asks about in `asked`: the same step, at the same pass. */
function sameGate(gate: Pick<Gate, 'step' | 'pass'>, asked: Pick<Gate, 'step' | 'pass'>): boolean {
  return gate.step === asked.step && gate.pass === asked.pass;
}

function seenBy(session: string | undefined): string {
  return session ?? '';
}

/** `state` as shown to `session`: every event up to now is seen. */
function shownTo(state: SkillState, session: string | undefined): SkillState {
  return { ...state, seen: { ...state.seen, [seenBy(session)]: state.seq } };
}

/** The open attempt `attempt` of `state`. */
export function openAttempt(state: SkillState, attempt: AttemptId): AttemptState | undefined {
  return state.attempts.find((open) => open.attempt === attempt);
}

/** The events `session` has not been shown. */
export function unseenEvents(state: SkillState, session: string | undefined): TurnEvent[] {
  const seen = state.seen[seenBy(session)] ?? 0;
  return state.events.filter((entry) => entry.seq > seen).map((entry) => entry.event);
}

/** The describe row `input` matches, with how describe says to start. */
export function describeRow(input: DescribeInput): { row: 'R1' | 'R16' | 'R2' | 'R23' | 'R17' | 'R27' | 'R18' | 'R3' | 'R4'; verdict: DescribeVerdict } {
  if (input.denied !== undefined) return { row: 'R1', verdict: { ask: 'denied', reason: input.denied } };
  if (input.undeliverable !== undefined) return { row: 'R16', verdict: { ask: 'denied', reason: input.undeliverable } };
  if (input.local !== undefined) return input.mode === 'unattended' ? { row: 'R23', verdict: { ask: 'denied', reason: input.local } } : { row: 'R2', verdict: { ask: 'local', reason: input.local } };
  if (input.mode === 'unattended' && input.attended !== undefined) return { row: 'R17', verdict: { ask: 'denied', reason: input.attended } };
  if (input.needsTool) return { row: 'R27', verdict: { ask: 'tool' } };
  if (input.mode === 'unattended') return { row: 'R18', verdict: { ask: 'unattended' } };
  if (input.needed.length > 0 || input.judged) return { row: 'R3', verdict: { ask: 'ask' } };
  return { row: 'R4', verdict: { ask: 'start' } };
}

/** The start row `input` matches: the refusal of a start that may not run here, or the run to start. */
export function startRow(input: StartInput): { row: 'R8' | 'R9'; refusal: Refusal } | { row: 'R25'; error: WorkflowFailure } | { row: 'R10'; start: StartRun } {
  if (input.local !== undefined) return { row: 'R8', refusal: { code: 'needs_local_driver', name: input.name, reason: input.local } };
  if (input.attended !== undefined) return { row: 'R25', error: { code: 'unattended_denied', message: input.attended } };
  if (input.check.kind === 'confirm-needed') {
    const { missing, outOfRange } = input.check;
    return { row: 'R9', refusal: { code: 'confirm_needed', name: input.name, missing, ...(outOfRange ? { outOfRange } : {}) } };
  }
  const { parallel, hitl } = input.check;
  return { row: 'R10', start: { parallel, hitl, host: hostOf(input.prompts, input.judge), ...(input.judge !== undefined ? { judge: input.judge } : {}) } };
}

/**
 * Whether a run asks the host question: it has a prompt step, which a child agent works, or its session judges it in a
 * subagent, which a host that starts no child (`h4`) cannot.
 */
function hostOf(hasPromptStep: boolean, judge: JudgedBy | undefined): UnansweredHost {
  return hasPromptStep || judge?.kind === 'session' ? { kind: 'pending', hasPromptStep } : { kind: 'none' };
}

/** The options a resume carries: `--parallel`, the HITL mode of `--hitl` or `--auto-approve`, and `judge: false` for `--no-judge`. */
export interface ResumeAnswers { parallel?: number; hitl?: HitlMode; judge?: false }

/**
 * The row of a resume, or of a takeover of a run this machine keeps no skill state of, once `WorkflowClient.resume`
 * answered `readied`: R20 or R21 when it refused the run, R8 for a run with a local route, R24 for an unattended run
 * that needs a person, as `attended` says, else R19 and the run this session drives anew in run mode `mode`. An
 * unattended call first takes R8 or R24 from the run as `WorkflowClient.carried` reads it, before any claim. Undefined
 * for a resume of a run whose skill state is `kept` here, as the claim installed nothing over it: the session rows take
 * the call as a `next`.
 */
export function readiedRow(input: { run: RunId; readied: RunReadied; kept: boolean; local?: string; mode: RunMode; attended?: string; needsTool: boolean; answers: ResumeAnswers; confirmed: boolean }):
  | { row: 'R19'; start: StartRun }
  | Answered<'R8' | 'R20' | 'R28'>
  | Answered<'R21' | 'R24', Relayed>
  | undefined {
  const { run, readied, answers } = input;
  const unattended = input.mode === 'unattended';
  switch (readied.kind) {
    case 'not-owner':
      return { row: 'R20', answer: { kind: 'error', refusal: { code: 'not_owner', run, owner: readied.owner, since: readied.since } } };
    case 'not-here':
      return { row: 'R20', answer: { kind: 'error', refusal: { code: 'run_not_found', run } } };
    case 'failed':
      return { row: 'R21', answer: { kind: 'engine-error', error: readied.failure, next: null } };
    case 'ready': {
      if (input.kept && !readied.installed) return undefined;
      const { description, judging } = readied;
      if (input.local !== undefined) return { row: 'R8', answer: { kind: 'error', refusal: { code: 'needs_local_driver', name: description.name, reason: input.local, run } } };
      if (unattended && input.attended !== undefined) return { row: 'R24', answer: { kind: 'engine-error', error: { code: 'unattended_denied', message: input.attended }, next: null } };
      if (input.needsTool) return { row: 'R28', answer: { kind: 'error', refusal: { code: 'tool_needed', run, answers, confirmed: input.confirmed } } };
      const judge = answers.judge !== false ? judgedBy(judging) : undefined;
      return {
        row: 'R19',
        start: {
          parallel: answers.parallel ?? 1, hitl: answers.hitl ?? (unattended ? 'auto-approve' : 'person'), host: hostOf(description.facts.prompts.length > 0, judge),
          ...(judge !== undefined ? { judge } : {}),
        },
      };
    }
    default: {
      const unhandled: never = readied;
      return unhandled;
    }
  }
}

/**
 * R26: an unattended resume or takeover of the skill state kept here, which R8 and R24 let through, leaves no person
 * in its options. Undefined when they are unattended already.
 */
export function unattendedRow(state: SkillState, answers: ResumeAnswers): Moved<'R26'> | undefined {
  if (state.options.mode === 'unattended') return undefined;
  return { row: 'R26', state: { ...state, options: { ...state.options, mode: 'unattended', hitl: answers.hitl ?? 'auto-approve' } } };
}

/**
 * R22: the refusal `WorkflowClient.resumeRefusal` gave a resume or a takeover, which only the person's yes, carried by
 * `--confirmed`, can lift. Undefined when it gave none.
 */
export function invokeRow(refusal: WorkflowFailure | undefined): Answered<'R22', Relayed> | undefined {
  if (refusal === undefined) return undefined;
  return { row: 'R22', answer: { kind: 'engine-error', error: refusal, next: refusal.code === 'confirm_needed' ? 'same' : null } };
}

/**
 * The session row of an agent call from `input.session` (S1, S2, S4), or R11 when this machine keeps no skill state of
 * the run. `takeover`: the call is `next --takeover`. `declared`: the tool the call names with `--tools default=<tool>`.
 */
export function callRow(state: SkillState | undefined, input: { run: RunId; session: string | undefined; tool: ToolId | undefined; declared?: ToolId; at: string; takeover: boolean }): Moved<'S1' | 'S4'> | Answered<'R11' | 'S2'> {
  if (!state) return { row: 'R11', answer: { kind: 'error', refusal: { code: 'not_skill_run', run: input.run, toolNamed: input.tool !== undefined } } };
  if (input.takeover) return { row: 'S4', state: takenOver(state, input) };
  const owner = state.orchestrator.session;
  if (owner !== undefined && input.session !== undefined && owner !== input.session) {
    const idleSeconds = Math.round((Date.parse(input.at) - Date.parse(state.orchestrator.lastCallAt)) / 1000);
    return { row: 'S2', answer: { kind: 'error', refusal: { code: 'orchestrator_active', run: state.run, idleSeconds } } };
  }
  // A tool the call declares wins; a session that becomes the owner works in its own; otherwise the run's tool is filled only from its owner.
  const adopts = owner === undefined && input.session !== undefined;
  const kept = adopts ? input.tool ?? state.orchestrator.tool
    : owner === undefined || owner === input.session ? state.orchestrator.tool ?? input.tool : state.orchestrator.tool;
  const tool = input.declared ?? kept;
  return { row: 'S1', state: { ...state, orchestrator: { ...state.orchestrator, session: state.orchestrator.session ?? input.session, ...(tool !== undefined ? { tool } : {}), lastCallAt: input.at } } };
}

/** S5: a runner's call, which takes no session row. */
export function runnerCallRow(): { row: 'S5' } {
  return { row: 'S5' };
}

/**
 * S6: an agent's report of `attempt` skips the session check, since the child of `attempt` may run in a session of its
 * own. Undefined when the agent does not report `attempt`, which then takes the session rows.
 */
export function reportCallRow(state: SkillState, attempt: AttemptId): { row: 'S6' } | undefined {
  const open = openAttempt(state, attempt);
  // A report already stored may come again: its send was refused, and the child runs the same literal.
  if (!state.settled.includes(attempt) && !(open && (reportedByAgent(open) || open.phase === 'reporting'))) return undefined;
  return { row: 'S6' };
}

/** The row of `next` once the engine answered `done`: X4 while an attempt is open, else X1 while a judge is, else X2. */
export function doneRow(state: SkillState): { row: 'X1' | 'X2' | 'X4' } | undefined {
  if (!state.done) return undefined;
  return { row: state.attempts.length > 0 ? 'X4' : state.judging?.open ? 'X1' : 'X2' };
}

/** The most attempts `state` keeps open at once: `--parallel`, and one under a serial host. */
export function childCap(state: SkillState): number {
  return state.host.kind === 'chosen' && state.host.children === 'serial' ? 1 : state.options.parallel;
}

/** Whether `state` has room for another attempt. */
export function hasSlot(state: SkillState): boolean {
  return state.attempts.length < childCap(state);
}

interface TickRequest {
  running: AttemptId[];
  canTakeLease: boolean;
  autoApprove: boolean;
}

/**
 * Whether `version`, read after the engine answered `end`, is the run file that end came from, and the end is out. A retry
 * can land between the two, and an end whose publication failed is published again only by an engine `next`, so for
 * either no version is kept, and X5 asks the engine again.
 */
function agrees(version: RunVersion, end: { outcome: string; prs: string[]; out: boolean }): boolean {
  return end.out && version.status === end.outcome && version.receipts === end.prs.length;
}

/**
 * The engine `next` of a tick (D1), or R12 while the host question waits. Once the run is done, a `next` that takes no
 * lease (X5) asks whether the engine reopened it or another driver ended it again, but only once `version`, what the
 * run file says now, moved from what the end kept (X7). A runner's check (`role: 'runner'`) takes no lease.
 */
export function tickRow(state: SkillState, input: { role: 'call' | 'runner'; version?: RunVersion }): { row: 'R12' | 'X7' } | { row: 'D1'; request: TickRequest } | (Moved<'X5'> & { request: TickRequest }) {
  const { role, version } = input;
  const running = state.attempts.map((open) => open.attempt);
  const autoApprove = state.options.hitl === 'auto-approve';
  const { done } = state;
  if (done) {
    const kept = done.version;
    if (version && kept && !version.creating && version.status === kept.status && version.revision === kept.revision && version.receipts === kept.receipts) return { row: 'X7' };
    return { row: 'X5', request: { running, canTakeLease: false, autoApprove }, state: version ? { ...state, done: { ...done, version } } : state };
  }
  if (state.host.kind === 'pending') return { row: 'R12' };
  return { row: 'D1', request: { running, canTakeLease: role === 'call' && hasSlot(state), autoApprove } };
}

/**
 * X6: the engine answered a run this driver saw done with anything but that same end: it reopened the run, as a retry
 * does, or another driver ended it again. `sameEnd`: the reply is a `done` naming the end the driver kept, and that end is out.
 */
export function reopenedRow(state: SkillState, input: { reply: EngineReply; sameEnd: boolean }): Moved<'X6'> | undefined {
  if (!state.done || input.sameEnd) return undefined;
  const { done: _done, ...rest } = state;
  return { row: 'X6', state: rest };
}

/** J1: the `score --next` of a tick while judging is on and the host is chosen. A runner's check takes no judge work. */
export function judgeTickRow(state: SkillState, role: 'call' | 'runner'): { row: 'J1'; request: { tool: string; running: string[]; canTakeLease: boolean } } | undefined {
  if (!state.judging || state.host.kind === 'pending') return undefined;
  const { tool, open } = state.judging;
  return { row: 'J1', request: { tool, running: open ? [open.ref] : [], canTakeLease: role === 'call' && !open } };
}

/** J2 and J6: what `score --next` answered while judging is on. */
export function scoreReplyRow(state: SkillState, input: { reply: ScoreReply; at: string }): MovedWithEffects<'J2' | 'J6'> | undefined {
  const { judging } = state;
  const { reply, at } = input;
  if (!judging) return undefined;
  switch (reply.kind) {
    case 'lease': {
      if (judging.open) return undefined;
      const open: Judge = { ...reply.judge, spawnedAt: at };
      const opened: SkillState = { ...state, judging: { ...judging, open } };
      return {
        row: 'J2', state: withEvent(opened, { kind: 'judging', step: open.step, scorers: open.scorers, ref: open.ref }), effects: [{ kind: 'spawn', attempt: open.attempt }],
      };
    }
    case 'idle':
      return undefined;
    case 'error':
      return reply.error.code === 'busy' ? undefined : { row: 'J6', state: judgingOff(state, reply.error), effects: [] };
    default: {
      const unhandled: never = reply;
      return unhandled;
    }
  }
}

/** J5: the open judge's `runner.lock` is free, and it was spawned more than `graceMs` before `at`. */
export function judgeFreeRow(state: SkillState, input: { at: string; graceMs: number }): MovedWithEffects<'J5'> | undefined {
  const open = state.judging?.open;
  if (!open || Date.parse(input.at) - Date.parse(open.spawnedAt) <= input.graceMs) return undefined;
  const failure = { code: 'judge_runner_gone', message: `The judge of step ${open.step} stopped before it answered, so this run judges nothing more here. Its lease lapses back to the queue for another driver.` };
  return { row: 'J5', state: judgingOff(state, failure), effects: [{ kind: 'stop-left', attempt: open.attempt }] };
}

/** J3 and J4: what the runner of the open judge, keyed by `attempt`, learned. */
export function judgeAnsweredRow(state: SkillState, input: { attempt: AttemptId; answer: JudgeAnswer }): Moved<'J3' | 'J4'> | undefined {
  const { judging } = state;
  const open = judging?.open;
  if (!judging || open?.attempt !== input.attempt) return undefined;
  const { answer } = input;
  if (answer.kind === 'failed') return { row: 'J4', state: judgingOff(state, answer.failure) };
  const dropped: SkillState = { ...state, judging: { tool: judging.tool } };
  return { row: 'J3', state: answer.labels.reduce((shown, { scorer, label }) => withEvent(shown, { kind: 'judged', step: open.step, scorer, label }), dropped) };
}

/** R13: the agent's answer to the host question; R15 when the run asks none now. */
export function chooseRow(state: SkillState, input: { choice: HostChoice; profile: HostProfile }): Moved<'R13'> | Answered<'R15'> {
  if (state.host.kind !== 'pending') return { row: 'R15', answer: { kind: 'error', refusal: { code: 'unknown_choice', run: state.run } } };
  // A run without a prompt step asked only for its judge, so its commands run as on any host.
  const chosen: SkillState = {
    ...state, host: state.host.hasPromptStep ? { kind: 'chosen', id: input.choice, children: input.profile.children, places: input.profile.places } : { kind: 'none' },
  };
  // The session judges in a fresh subagent, which a host that starts no child agent cannot give it.
  if (input.choice !== 'h4' || chosen.sessionJudge === undefined) return { row: 'R13', state: chosen };
  const { sessionJudge: _sessionJudge, ...rest } = chosen;
  return { row: 'R13', state: withEvent(rest, { kind: 'judging-off', failure: { code: 'no_child_agent', message: 'This host starts no child agent, so this session does not judge the run: another driver judges its scored steps.' } }) };
}

/** K1 to K3: the ack of the dispatch of `attempt`; R14 while the host question waits. */
export function ackRow(state: SkillState, attempt: AttemptId): Moved<'K1' | 'K2'> | Answered<'K3' | 'R14'> {
  if (state.host.kind === 'pending') return choicePending(state);
  const open = openAttempt(state, attempt);
  if (open?.phase === 'offered') {
    const { reissued: _reissued, ...rest } = open;
    return { row: 'K1', state: withAttempt(state, { ...rest, phase: 'dispatched' }) };
  }
  if (open?.phase === 'dispatched') return { row: 'K2', state };
  return { row: 'K3', answer: { kind: 'error', refusal: { code: 'unknown_offer', run: state.run, attempt } } };
}

/**
 * The row of `next --attempt a --adopt dir`: K4 gives `dir` to a new runner of `a`, an attempt that waits for its
 * place, which prepares it there; K5 refuses any other attempt; R14 waits for the host question.
 */
export function adoptRow(state: SkillState, input: { attempt: AttemptId; dir: string; at: string }): MovedWithEffects<'K4'> | Answered<'K5' | 'R14'> {
  if (state.host.kind === 'pending') return choicePending(state);
  const open = openAttempt(state, input.attempt);
  if (open?.phase !== 'placing') {
    return { row: 'K5', answer: { kind: 'error', refusal: { code: 'unknown_attempt', run: state.run, attempt: input.attempt, ...(open ? { phase: open.phase } : {}) } } };
  }
  const preparing: AttemptState = { ...baseOf(open), spawnedAt: input.at, phase: 'preparing', request: { kind: 'adopt', dir: input.dir } };
  return { row: 'K4', state: withAttempt(state, preparing), effects: [{ kind: 'spawn', attempt: open.attempt }] };
}

function choicePending(state: SkillState): Answered<'R14'> {
  return { row: 'R14', answer: { kind: 'error', refusal: { code: 'choice_pending', run: state.run } } };
}

/**
 * The row of the engine's reply to a tick's `next`: a lease (D6 to D8), a gate (D10 to D12), a wait (D13 to D15), the
 * end (D16), or an error (D17). Undefined once the run is done. `waiting` says why the run leases nothing more; `turn`
 * is the turn a row decides for its call.
 */
export function replyRow(state: SkillState, input: { reply: EngineReply; at: string; version?: RunVersion }):
  | (MovedWithEffects<'D6' | 'D7' | 'D8' | 'D10' | 'D11' | 'D12' | 'D13' | 'D14' | 'D15' | 'D16'> & TickTurn)
  | Answered<'D17', Relayed>
  | undefined {
  if (state.done) return undefined;
  const { reply: engine, at } = input;
  switch (engine.kind) {
    case 'lease': {
      const { lease } = engine;
      const { attempt, step: id, revision, expiresAt } = lease;
      const hosted = lease.executor === 'prompt' && lease.writes && state.host.kind === 'chosen' && state.host.places === 'host';
      const preparing = withAttempt(state, {
        attempt, step: id, revision, spawnedAt: at, ...(expiresAt !== undefined ? { expiresAt } : {}), phase: 'preparing', ...(hosted ? { request: { kind: 'host' } } : {}),
      });
      return { row: lease.executor === 'command' ? 'D6' : hosted ? 'D8' : 'D7', state: withEvent(preparing, { kind: 'started', step: id, attempt }), effects: [{ kind: 'spawn', attempt, job: { lease: engine.raw } }] };
    }
    case 'wait':
      if (engine.held.length > 0 && state.attempts.length === 0) {
        return { row: 'D14', state, effects: [], waiting: { reason: engine.reason, held: engine.held }, turn: { kind: 'turn', events: 'unseen', after: 'none', quiet: false } };
      }
      if (engine.delivering.length > 0) {
        return { row: 'D13', state, effects: [], waiting: { reason: engine.reason, delivering: engine.delivering }, turn: { kind: 'turn', events: 'unseen', after: 'poll', quiet: false } };
      }
      return { row: 'D15', state, effects: [], waiting: { reason: engine.reason } };
    case 'hitl': {
      const asked = engine.gate;
      const row = asked.required ? 'D10' : state.options.hitl === 'recommend' ? 'D12' : 'D11';
      const waiting = asked.required ? { waiting: { reason: `${asked.step} waits for the person's answer` } } : {};
      if (state.gate && sameGate(state.gate, asked)) return { row, state, effects: [], ...waiting };
      const seq = state.seq + 1;
      const gate: Gate = asked.required ? { ...asked, required: true, seq } : { ...asked, required: false, decide: row === 'D12' ? 'agent' : 'person', seq };
      return { row, state: { ...state, seq, gate }, effects: [], ...waiting };
    }
    case 'done':
      return {
        row: 'D16', effects: [],
        state: { ...state, seq: state.seq + 1, done: { outcome: engine.outcome, ...(engine.failure ? { failure: engine.failure } : {}), prs: engine.prs, ...(input.version && agrees(input.version, engine) ? { version: input.version } : {}) } },
      };
    case 'error':
      return { row: 'D17', answer: { kind: 'engine-error', error: engine.error, next: 'next' } };
    default: {
      const unhandled: never = engine;
      return unhandled;
    }
  }
}

/** D27: a wait that holds a step says nothing of a gate, which only a `next` that takes no lease answers. */
export function heldProbeRow(reply: EngineReply): { row: 'D27' } | undefined {
  return reply.kind === 'wait' && reply.held.length > 0 ? { row: 'D27' } : undefined;
}

/**
 * H5: the reply of a `next`, before its own row, shows the journalled gate answered elsewhere: it is done, a wait that
 * holds nothing, or another gate.
 */
export function gateCheckRow(state: SkillState, reply: EngineReply): Moved<'H5'> | undefined {
  const { gate } = state;
  if (state.done || !gate) return undefined;
  const gone = reply.kind === 'done' || (reply.kind === 'wait' && reply.held.length === 0) || (reply.kind === 'hitl' && !sameGate(gate, reply.gate));
  if (!gone) return undefined;
  const { gate: _gate, ...rest } = state;
  return { row: 'H5', state: rest };
}

/** H1 to H4: the engine's answer to `respond --driver skill`. */
export function respondedRow(state: SkillState, reply: RespondReply): Moved<'H1' | 'H2'> | Answered<'H3' | 'H4', Relayed> {
  if (reply.kind === 'answered') {
    const { gate, ...rest } = state;
    const kept = gate && !sameGate(gate, reply) ? { ...rest, gate } : rest;
    return { row: 'H2', state: withEvent(kept, { kind: 'answered', step: reply.step, choice: reply.choice, channel: reply.channel, agent: reply.agent }) };
  }
  if (reply.error.code === 'repeated_response') return { row: 'H1', state };
  if (reply.error.code === 'agent_in_path') return { row: 'H3', answer: { kind: 'engine-error', error: reply.error, next: 'poll' } };
  return { row: 'H4', answer: { kind: 'engine-error', error: reply.error, next: 'next' } };
}

/** D2 to D5: the engine no longer leases `attempt` to this driver: it was cancelled, or it passed its deadline. */
export function cancelledRow(state: SkillState, input: { attempt: AttemptId; at: string }): Moved<'D2' | 'D3' | 'D4' | 'D5'> | undefined {
  const open = state.done ? undefined : openAttempt(state, input.attempt);
  if (!open) return undefined;
  const stopping = (by: 'runner' | 'agent'): AttemptState => ({ ...baseOf(open), phase: 'stopping', by, why: stopReason(open, input.at) });
  switch (open.phase) {
    case 'queued':
    case 'placing': {
      const others = state.attempts.filter((other) => other.attempt !== open.attempt);
      return { row: 'D2', state: withEvent({ ...state, attempts: others }, { kind: 'stopped', step: open.step, attempt: open.attempt, why: stopReason(open, input.at) }) };
    }
    case 'preparing':
    case 'running':
      return { row: 'D3', state: withAttempt(state, stopping('runner')) };
    case 'offered':
    case 'dispatched':
      return { row: 'D4', state: withAttempt(state, stopping('agent')) };
    case 'stopping':
    case 'reporting':
      return { row: 'D5', state };
    default: {
      const unhandled: never = open;
      return unhandled;
    }
  }
}

/** D18: a foreground call that spawned runners waits for them before it answers, unless the run is done. */
export function graceRow(state: SkillState): { row: 'D18' } | undefined {
  return state.done ? undefined : { row: 'D18' };
}

/** D19: the run lock stayed busy. */
export function lockBusyRow(run: RunId): Answered<'D19', Refused> {
  return { row: 'D19', answer: { kind: 'error', refusal: { code: 'driver_running', run } } };
}

/** D20: the turn of a foreground call, after its tick: the turn a row of that tick decided, else a turn with `then: poll`. */
export function turnRow(state: SkillState, input: { session: string | undefined; ticked: TickTurn }): Moved<'D20'> & { turn: TurnAnswer; waiting?: Waiting } {
  const { waiting, turn } = input.ticked;
  return { row: 'D20', state: shownTo(state, input.session), turn: turn ?? { kind: 'turn', events: 'unseen', after: 'poll', quiet: false }, ...(waiting ? { waiting } : {}) };
}

/**
 * The row of a poll tick: the turn it answers (D22 to D26), or D21, which sleeps and ticks again. `busy`: the lock was
 * busy, so nothing ticked; `ticked`: what the tick left, when one ran.
 */
export function pollRow(state: SkillState, input: { session: string | undefined; busy: boolean; boundReached: boolean; ticked: TickTurn }):
  | { row: 'D21' }
  | (Moved<'D22' | 'D23' | 'D24' | 'D25' | 'D26'> & { turn: TurnAnswer; waiting?: Waiting }) {
  const { session, busy, boundReached, ticked } = input;
  const waiting = ticked.waiting ? { waiting: ticked.waiting } : {};
  const seen = state.seen[seenBy(session)] ?? 0;
  const unseenGate = state.gate !== undefined && state.gate.seq > seen;
  if (!busy && (waitsForAgent(state) || unseenGate)) return { row: 'D22', state, turn: { kind: 'turn', events: 'none', after: 'wake', quiet: true } };
  if (ticked.turn?.after === 'none') return { row: 'D26', state, turn: { kind: 'turn', events: 'none', after: 'wake', quiet: true }, ...waiting };
  if (state.done && !busy && state.attempts.length === 0 && seen < state.seq) {
    return { row: 'D23', state: shownTo(state, session), turn: { kind: 'turn', events: 'unseen', after: 'poll', quiet: false } };
  }
  if (!busy && unseenEvents(state, session).some((event) => event.kind === 'settled' || event.kind === 'stopped')) {
    return { row: 'D25', state: shownTo(state, session), turn: { kind: 'turn', events: 'unseen', after: 'poll', quiet: true }, ...waiting };
  }
  if (boundReached) return { row: 'D24', state, turn: { kind: 'turn', events: 'none', after: 'poll', quiet: true }, ...waiting };
  return { row: 'D21' };
}

/** C1: the command of `attempt` runs in its prepared place. */
export function preparedRow(state: SkillState, attempt: AttemptId): Moved<'C1'> | undefined {
  const open = openAttempt(state, attempt);
  if (open?.phase !== 'preparing') return undefined;
  return { row: 'C1', state: withAttempt(state, { ...open, phase: 'running' }) };
}

/** C2: the prompt of `attempt` is offered to the agent as `dispatch`. */
export function offerRow(state: SkillState, input: { attempt: AttemptId; dispatch: Dispatch }): Moved<'C2'> | undefined {
  const open = openAttempt(state, input.attempt);
  if (open?.phase !== 'preparing') return undefined;
  return { row: 'C2', state: withAttempt(state, { ...open, phase: 'offered', dispatch: input.dispatch }) };
}

/** C4: the place of `attempt` is held by `behind`, another open attempt, so it waits for it. */
export function placeBusyRow(state: SkillState, input: { attempt: AttemptId; behind: AttemptId }): Moved<'C4'> | undefined {
  const open = openAttempt(state, input.attempt);
  if (open?.phase !== 'preparing') return undefined;
  return { row: 'C4', state: withAttempt(state, { ...open, phase: 'queued', behind: input.behind }) };
}

/** D9: `attempt` waited for a place whose holder is no longer open, so its runner starts again. */
export function unqueueRow(state: SkillState, input: { attempt: AttemptId; at: string }): MovedWithEffects<'D9'> | undefined {
  const open = openAttempt(state, input.attempt);
  if (open?.phase !== 'queued' || openAttempt(state, open.behind)) return undefined;
  const { behind: _behind, ...rest } = open;
  return { row: 'D9', state: withAttempt(state, { ...rest, phase: 'preparing', spawnedAt: input.at }), effects: [{ kind: 'spawn', attempt: open.attempt }] };
}

/** C7 and C3: `attempt` failed before its step ran: its place or setup (`cause: 'place'`), or its child's model. */
export function prepareFailedRow(state: SkillState, input: { attempt: AttemptId; body: ReportBody; cause: 'place' | 'model' }): MovedWithEffects<'C3' | 'C7'> | undefined {
  const open = openAttempt(state, input.attempt);
  if (open?.phase !== 'preparing' && open?.phase !== 'running') return undefined;
  const reporting: AttemptState = { ...baseOf(open), phase: 'reporting', body: input.body };
  return { row: input.cause === 'place' ? 'C7' : 'C3', state: withAttempt(state, reporting), effects: [{ kind: 'send', attempt: input.attempt, body: input.body }] };
}

/** C8: the command of `attempt` exited, and `body` reports it. */
export function exitedRow(state: SkillState, input: { attempt: AttemptId; body: ReportBody; tail?: string }): MovedWithEffects<'C8'> | undefined {
  const open = openAttempt(state, input.attempt);
  if (open?.phase !== 'running') return undefined;
  const reporting: AttemptState = { ...open, phase: 'reporting', body: input.body, ...(input.tail ? { tail: input.tail } : {}) };
  return { row: 'C8', state: withAttempt(state, reporting), effects: [{ kind: 'send', attempt: input.attempt, body: input.body }] };
}

/**
 * C10 and C11: the `runner.lock` of `attempt` is free, and its runner was spawned more than `graceMs` before `at`, so it
 * is gone rather than not yet started. It was stopping the attempt, so the attempt is given up (C11), or it prepared or
 * ran it, so it starts again (C10).
 */
export function runnerFreeRow(state: SkillState, input: { attempt: AttemptId; at: string; graceMs: number }): MovedWithEffects<'C10' | 'C11'> | undefined {
  const open = openAttempt(state, input.attempt);
  if (!open || Date.parse(input.at) - Date.parse(open.spawnedAt) <= input.graceMs) return undefined;
  if (open.phase === 'stopping' && open.by === 'runner') {
    const given = released(state, open, 'C11');
    return { ...given, effects: [{ kind: 'stop-left', attempt: open.attempt }, ...given.effects] };
  }
  if (open.phase !== 'preparing' && open.phase !== 'running') return undefined;
  const respawned = withAttempt(state, { ...open, spawnedAt: input.at });
  return {
    row: 'C10', state: withEvent(respawned, { kind: 'restarted', step: open.step, attempt: open.attempt }),
    effects: [{ kind: 'stop-left', attempt: open.attempt }, { kind: 'spawn', attempt: open.attempt }],
  };
}

/** C9: the runner found its attempt stopping, and its command, if it started one, is stopped. */
export function runnerStopRow(state: SkillState, attempt: AttemptId): MovedWithEffects<'C9'> | undefined {
  const open = openAttempt(state, attempt);
  if (open?.phase !== 'stopping' || open.by !== 'runner') return undefined;
  return released(state, open, 'C9');
}

/** P7 to P10: the engine's answer to the report of `attempt` that was sent. */
export function reportedRow(state: SkillState, input: { attempt: AttemptId; reply: ReportReply; at: string }): Moved<'P7' | 'P8' | 'P9'> | Answered<'P10', Relayed> | undefined {
  const open = openAttempt(state, input.attempt);
  if (open?.phase !== 'reporting') return undefined;
  const others = state.attempts.filter((other) => other.attempt !== open.attempt);
  if (input.reply.kind === 'error' && input.reply.error.code === 'lease_cancelled') {
    const why = open.stopped ?? stopReason(open, input.at);
    return { row: 'P9', state: withEvent({ ...state, attempts: others, settled: [...state.settled, open.attempt] }, { kind: 'stopped', step: open.step, attempt: open.attempt, why }) };
  }
  if (input.reply.kind === 'error' && input.reply.error.code !== 'repeated_report') {
    return { row: 'P10', answer: { kind: 'engine-error', error: input.reply.error, next: 'same' } };
  }
  const outcome = input.reply.kind === 'reported' ? input.reply.outcome : open.body.outcome;
  // The engine's verdict wins: it may fail a step whose runner saw it succeed, as a read-only step that wrote.
  const failure = (input.reply.kind === 'reported' ? input.reply.failure : undefined) ?? open.body.failure;
  const dropped = { ...state, attempts: others, settled: [...state.settled, open.attempt] };
  const settled = withEvent(dropped, {
    kind: 'settled', step: open.step, outcome,
    ...(open.body.exitCode !== undefined ? { exitCode: open.body.exitCode } : {}),
    ...(failure ? { failure } : {}),
    ...(open.tail ? { tail: open.tail } : {}),
  });
  return { row: input.reply.kind === 'reported' ? 'P7' : 'P8', state: settled };
}

/** P11: the report a crash or a refusal left stored for `attempt` is sent again. */
export function resendRow(state: SkillState, attempt: AttemptId): MovedWithEffects<'P11'> | undefined {
  const open = openAttempt(state, attempt);
  if (open?.phase !== 'reporting') return undefined;
  return { row: 'P11', state, effects: [{ kind: 'send', attempt, body: open.body }] };
}

/**
 * P1 to P6, and P11: an agent's `report --attempt`. `result` is what the attempt's child left, read before the row is
 * taken. Undefined once the run is done and the attempt is neither settled nor open.
 */
export function reportRow(state: SkillState, input: { attempt: AttemptId; modelUnavailable: boolean; result: ChildResult }):
  | { row: 'P1'; repeated: true }
  | MovedWithEffects<'P4' | 'P5' | 'P6' | 'P11'>
  | Answered<'P2' | 'P3' | 'R14'>
  | undefined {
  if (state.settled.includes(input.attempt)) return { row: 'P1', repeated: true };
  const open = openAttempt(state, input.attempt);
  if (open?.phase === 'stopping' && open.by === 'agent') return released(state, open, 'P6');
  if (open?.phase === 'reporting') return resendRow(state, open.attempt);
  if (state.done) return undefined;
  if (state.host.kind === 'pending') return choicePending(state);
  if (!open) return { row: 'P2', answer: { kind: 'error', refusal: { code: 'unknown_attempt', run: state.run, attempt: input.attempt } } };
  if (open.phase !== 'offered' && open.phase !== 'dispatched') {
    return { row: 'P3', answer: { kind: 'error', refusal: { code: 'not_dispatched', run: state.run, attempt: input.attempt, phase: open.phase } } };
  }
  const { model } = open.dispatch;
  const base = { attempt: open.attempt, revision: open.revision, driver: state.driver };
  const unavailable = input.modelUnavailable && model.by !== 'definition';
  const failure = unavailable
    ? { code: 'model_unavailable', message: `Step "${open.step}" needs model ${model.name}, which the host of this coding session cannot run.` }
    : input.result.kind === 'failure' ? input.result.failure : undefined;
  const body: ReportBody = failure
    ? { ...base, outcome: 'failed', message: failure.message, failure }
    : { ...base, outcome: 'success', ...(input.result.kind === 'output' ? { outputs: input.result.output } : {}) };
  const { dispatch: _dispatch, ...rest } = open;
  return { row: unavailable ? 'P4' : 'P5', state: withAttempt(state, { ...rest, phase: 'reporting', body }), effects: [{ kind: 'send', attempt: open.attempt, body }] };
}

/**
 * `state` driven from session `session`, working in `tool`, from `at` on. Every dispatch an earlier session was shown is
 * offered again, as reissued, since that session may have started its child. The new session is told only what the
 * earlier one was not.
 */
function takenOver(state: SkillState, { session, tool, at }: { session: string | undefined; tool: ToolId | undefined; at: string }): SkillState {
  const attempts = state.attempts.map((open): AttemptState => {
    if (open.phase !== 'offered' && open.phase !== 'dispatched') return open;
    return { ...open, phase: 'offered', reissued: true };
  });
  const from = state.orchestrator.session;
  const told = Math.max(state.seen[seenBy(from)] ?? 0, state.seen[seenBy(session)] ?? 0);
  return withEvent(
    { ...state, attempts, orchestrator: { ...(session !== undefined ? { session } : {}), ...(tool !== undefined ? { tool } : {}), lastCallAt: at }, seen: { ...state.seen, [seenBy(session)]: told } },
    { kind: 'takeover', ...(from !== undefined ? { from } : {}) },
  );
}

/** `state` with judging off for `failure`: nothing more is judged here, and an open judge's lease lapses. */
function judgingOff(state: SkillState, failure: WorkflowFailure): SkillState {
  const { judging: _judging, ...rest } = state;
  return withEvent(rest, { kind: 'judging-off', failure: { code: failure.code, message: failure.message } });
}

/**
 * The row the runner of `open`, an attempt whose host makes its place, takes when that place is still to make: C6 when
 * the place the agent adopted was `refused`, else C5. Either way the attempt waits for the agent to adopt one.
 */
export function placingRow(state: SkillState, open: Extract<AttemptState, { phase: 'preparing' }>, input: { ask: PlaceAsk; refused?: string }): Moved<'C5' | 'C6'> {
  const placing: AttemptState = { ...baseOf(open), phase: 'placing', ask: input.ask, ...(input.refused !== undefined ? { refused: input.refused } : {}) };
  return { row: input.refused !== undefined ? 'C6' : 'C5', state: withAttempt(state, placing) };
}
