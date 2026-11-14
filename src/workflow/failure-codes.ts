import { LIMIT_FAILURES } from './requirements.js';

/**
 * Every failure code teamai sets: the codes the engine and the local driver write on a step or a run, then the
 * refusals a command, driver or step runtime answers, several of which a step runtime's refusal carries onto its step.
 * A run record keeps a failure code only when it is one of these, since a code a model writes into its result, or
 * another driver reports, can be any text. Lint (`teamai/workflow-failure-codes`) rejects a code literal under
 * `src/workflow` that is neither listed here nor a judge's (`JUDGE_FAILURES`), so a new code teamai sets on a step
 * must be added here to pass lint.
 */
export const FAILURE_CODES = [
  'cancelled', 'hitl_required',
  'loop_exhausted', 'invalid_output', 'invalid_template', 'invalid_inputs', 'invalid_items', 'item_cycle', 'input_rejected', 'command_failed',
  'tool_failed', 'tool_unavailable', 'agent_unavailable', 'model_unavailable', 'read_only_dirty', 'unreported_changes', 'tool_unconfigured', 'tool_unsupported', 'usage_limited',
  'merge_conflict', 'base_config', 'push_failed', 'workspace_base', 'bad_session',
  ...LIMIT_FAILURES,
  'delivery_failed', 'protected_path',
  // A step's workflow output whose definition cannot deliver what it declares, as admission refuses it.
  'bad_delivery',
  'trial_prepare_failed', 'clone_prepare_failed', 'role_unavailable',
  'confined_invalid', 'confined_tool_unavailable', 'confined_failed', 'confined_reply_invalid', 'confined_report_mismatch', 'confined_unoffered',
  'runtime_failed', 'runtime_interrupted', 'runtime_lost', 'runner_crashed', 'requirement_unmet', 'login_missing', 'login_held', 'login_not_written_back',
  'fleet_member_gone', 'fleet_unpublishable', 'fleet_record_unreadable', 'fleet_record_newer', 'fetch_failed',
  // Refusals of a driver's call or a member's command about a run.
  'invalid_json', 'driver_running', 'invalid_run', 'repeated_response', 'agent_in_path', 'stale_response', 'retried', 'end_reached', 'repeated_report', 'wrong_attempt', 'invalid_report', 'lease_cancelled', 'interrupted', 'run_unreadable', 'driver_stuck', 'ambiguous_run', 'busy', 'workflow_recursion', 'workflow_not_found',
  // Refusals of a run handover, answered to the command or driver that asked for it.
  'not_owner', 'unsupported_repo', 'reports_unreachable', 'reports_failed', 'run_not_found', 'run_not_published', 'run_mismatch',
  'state_conflict', 'state_moved', 'definition_mismatch', 'records_pending', 'snapshot_unsupported', 'secret_detected', 'local_path_detected', 'origin_unavailable', 'commit_missing',
  'branch_diverged', 'sessions_not_archived', 'owner_active', 'run_offered', 'place_kept',
  // Refusals of a driver's or member's request about a run that is already past it.
  'stale_revision', 'wrong_driver', 'run_settled', 'step_not_found', 'not_hitl', 'not_waiting', 'invalid_choice', 'not_cancellable', 'not_retryable',
  // Refusals of a retry of a run past workflows.retention, whose branches doctor --fix may have removed; the run stays settled.
  'run_expired',
  // Refusals of a retry of a succeeded run whose cleanup deleted branches that did not come back; the run stays settled.
  'branches_not_restored',
  // Refusals of a hand label, or of scoring whose settings cannot be read.
  'label_invalid', 'scoring_settings_invalid',
  // Work the driver's judge tools cannot run the scorer's model for; it stays open for another driver.
  'judge_model_unavailable',
  // Refusals of a teamai score or teamai workflow command line before it reads any run or judge work.
  'invalid_arguments', 'invalid_pass', 'not_initialized', 'unsupported_driver', 'invalid_tools',
  // Refusals of teamai workflow start for a run whose pull requests would have no branch to target.
  'no_base_branch',
  // Refusals of a start with an unattended prompt step that no strict sandbox covers, before any run exists.
  'unattended_unsandboxed',
  // Refusals of a start from an agent session that the workflow's invoke does not let start it.
  'invoke_denied',
  // Refusals of an agent's start of an invoke: ask workflow in an unattended run, where no person can agree.
  'unattended_denied',
  // Refusals of a workflow command from inside a workflow attempt, or of a start from a workflow's place.
  'nested_workflow',
  // A place the session host made that a prepare cannot adopt; the attempt stays leased.
  'adopt_mismatch',
  // Refusals of a --driver skill call, answered to the agent with the command it can run instead.
  'confirm_needed', 'needs_local_driver', 'not_skill_run', 'orchestrator_active', 'choice_pending', 'unknown_choice', 'unknown_offer', 'unknown_attempt', 'not_dispatched', 'tool_needed',
  // An error thrown inside a --driver skill call, answered to the agent as one envelope with its message.
  'skill_call_failed',
  // Why the skill driver stopped judging a run, told to the agent in a judging-off event.
  'no_child_agent', 'scoring_run_ended',
  // Refusals of teamai benchmark run and plan, before any run exists.
  'team_revision_unpullable', 'benchmark_not_found', 'commit_unreachable', 'check_files_unwritable',
  'arm_model_missing', 'arm_unpublishable', 'arm_team_unresolved', 'arm_team_unreadable', 'arm_team_unclean', 'arm_workflow_unrunnable',
  'judge_unpublishable',
  // Refusals of teamai benchmark run and plan where a task's covers cannot be compared (#1605).
  'task_covers_ambiguous',
  // Refusals of teamai benchmark try, which tries one task file and creates no run.
  'benchmark_invalid', 'task_try_failed',
  // Refusals of teamai benchmark plan where the team a trial runs cannot be pinned.
  'team_ref_blocked',
  // Refusals of teamai workflow publish and a claim of an isolated run, which stays on the machine that started it.
  'isolated_run',
  // Refusals of teamai workflow publish and a claim while a step of a private workflow is open on this machine.
  'private_open',
  // Refusals of teamai workflow publish while a step's attempt is out on a fleet pool.
  'fleet_attempts_out',
  // Refusals of teamai score --run, answered to the member who asked for a pass to be judged.
  'scoring_unavailable', 'pass_not_found', 'scorer_not_found', 'step_ambiguous', 'evidence_missing',
  // Refusals of teamai score --session, answered to the member who asked for a session to be judged.
  'session_required', 'source_required', 'session_not_found', 'session_ambiguous', 'scorer_invalid',
  // Refusals of a teamai-score subject that is none of run:, session: or team-session:.
  'subject_invalid',
  // Why the local driver stopped with only steps confined to a directory left, which no tool here can run.
  'confined_pending',
  // Refusals of a score verb called outside a leased teamai-score attempt, and of a label no person gave.
  'score_attempt_required', 'hand_label_refused',
  // Refusal of teamai session list --finished, in a run no person started, of inputs other than the session policies.
  'policy_override_refused',
  // Refusals of a score verb whose --evidence is no group's evidence directory of its run.
  'evidence_unreadable',
  // Why a scorer of a teamai-score group has no label yet: its CI has not finished; and a check stage that never ran.
  'ci_pending', 'stage_record_missing',
  // Why teamai score ended its teamai-score run with a scorer unlabelled: its judge waits for a driver that can run it,
  // plan left it out, or a step of its group failed with no code of its own.
  'judge_pending', 'not_planned', 'score_step_failed',
  // Refusals of a --driver definition, and why a step runtime could not do what it was asked: answered at start or
  // resume, or carried in the message of an attempt that records runtime_failed.
  'driver_not_found', 'driver_invalid', 'driver_namespace_conflict', 'runtime_not_found', 'runtime_namespace_conflict', 'runtime_not_accepted',
  // Why the sandbox profile a driver's sandbox entry names cannot be used: none is declared, or it does not parse or is reached through a link.
  'sandbox_profile_not_found', 'sandbox_profile_invalid',
  // A runtime that answers a check only that it cannot tell more without starting something.
  'check_unsupported',
  'bad_option', 'credential_missing', 'runtime_exited', 'runtime_not_sent', 'runtime_unanswered', 'runtime_protocol', 'runtime_gone', 'exec_failed',
  // A stop a step runtime could not confirm (the protocol's CANCEL_FAILED), which a fleet owner and a setup a teamai
  // before this one left also end a step with.
  'cancel_failed',
  // Why a step runtime could not wake a fleet member: it has no machine to wake one on.
  'wake_unavailable',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/** Whether `code` is one teamai sets, which a run record may publish. */
export function isFailureCode(code: string): code is FailureCode {
  return FAILURE_CODES.some((known) => known === code);
}
