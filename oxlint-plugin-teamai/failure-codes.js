import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { isIdentifier } from '@babel/types';

/** Literal codes stay owned by their runtime declarations, including LIMIT_FAILURES. */
/** @param {string} file @param {string} name */
function policyArray(file, name) {
  const source = fs.readFileSync(fileURLToPath(new URL('../' + file, import.meta.url)), 'utf8');

  const declarations = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body
    .map((statement) => statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement)
    .flatMap((statement) => statement?.type === 'VariableDeclaration' ? statement.declarations : []);

  const declaration = declarations.find((candidate) => isIdentifier(candidate.id, { name }));
  const initializer = declaration?.init;
  const array = initializer?.type === 'TSAsExpression' ? initializer.expression : initializer;

  if (array?.type !== 'ArrayExpression') throw new Error(`Failure-code policy cannot read ${name} in ${file}. Keep its literal array declaration available to lint.`);

  return array;
}

/** @param {string} file @param {string} name @returns {string[]} */
function literalStrings(file, name) {
  return policyArray(file, name).elements.flatMap((element) => {
    if (element?.type === 'StringLiteral') return [element.value];

    if (element?.type === 'SpreadElement' && element.argument.type === 'Identifier' && element.argument.name === 'LIMIT_FAILURES') return literalStrings('src/workflow/requirements.ts', 'LIMIT_FAILURES');
    throw new Error(`Failure-code policy cannot resolve a nonliteral entry in ${name}.`);
  });
}

const diagnostics = ['unknown_key', 'missing_needs', 'false_if', 'bad_template', 'dotted_name', 'undeclared_output', 'undeclared_end', 'bad_loop', 'bad_workspace', 'bad_role', 'workflow_namespace_conflict', 'prompt_namespace_conflict', 'benchmark_namespace_conflict', 'bad_delivery', 'bad_invoke', 'bad_alias', 'alias_conflict',
  // Why pull refuses a team file that would replace a default its contract guards.
  'default_override_alias', 'score_override_contract', 'score_override_command', 'score_override_workflow_step', 'score_override_prompt',
  'score_override_confined_dir', 'score_override_judge_prompt', 'score_override_step_missing', 'score_override_publish',
  // Why pull refuses a step that runs teamai-score or teamai-finished-sessions and lists scorers.
  'judging_scored'];

const answers = ['invalid_json', 'driver_running', 'invalid_run', 'repeated_response', 'agent_in_path', 'stale_response', 'retried', 'end_reached', 'repeated_report', 'wrong_attempt', 'invalid_report', 'lease_cancelled', 'interrupted', 'run_unreadable', 'driver_stuck', 'ambiguous_run', 'busy', 'workflow_recursion', 'workflow_not_found',
      // Refusals of a run handover, answered to the command or driver that asked for it.
      'not_owner', 'unsupported_repo', 'reports_unreachable', 'reports_failed', 'run_not_found', 'run_not_published', 'run_mismatch',
      'state_conflict', 'state_moved', 'definition_mismatch', 'records_pending', 'snapshot_unsupported', 'secret_detected', 'local_path_detected', 'origin_unavailable', 'commit_missing',
      'branch_diverged', 'sessions_not_archived',
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
      // Refusals of a local start with a step the local driver could never take for a strict requirement, before any run exists.
      'requirement_unmet',
      // Refusals of a start with an unattended prompt step that no strict sandbox covers, before any run exists.
      'unattended_unsandboxed',
      // Refusals of a start from an agent session that the workflow's invoke does not let start it.
      'invoke_denied',
      // Refusals of an agent's start of an invoke: ask workflow in an unattended run, where no person can agree.
      'unattended_denied',
      // Refusals of a workflow command from inside a workflow attempt, or of a start from a workflow's place.
      'nested_workflow',
      // A place the host made that a prepare cannot adopt; the attempt stays leased.
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
      // Why a scorer got no label from a judge attempt: kept with its mark under scores/, never on a run.
      ...literalStrings('src/scorers/label.ts', 'JUDGE_FAILURES')];

/** Every recognized producer code, including diagnostics and command-only refusals. */
export const KNOWN_FAILURE_CODES = new Set([...diagnostics, ...answers, ...literalStrings('src/workflow/records.ts', 'RECORDED_FAILURES')]);
