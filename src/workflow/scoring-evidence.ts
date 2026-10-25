import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentSession } from '../session-flow/agent-session.js';
import { judgedTranscript } from '../session-flow/session-work.js';
import { collectTeamSecrets } from '../env-resolution.js';
import type { LocalConfig } from '../types.js';
import { collectEnvSecrets, redact } from '../utils/redact.js';
import {
  fencedEvidence, isEvidenceReady, rubricPrompt, writeEvidence, SESSION_MAX_CHARS, SUBAGENT_MAX_CHARS, type EvidenceGap, type Rubrics,
} from '../scorers/evidence.js';
import type { RunSubject } from '../scorers/label.js';
import { firstSettled, isUnder, passRange, passesWithin, runPasses } from './loop.js';
import { stepDefinitions } from './scope.js';
import { agentPassOf, type StepPass } from './step-state.js';
import type { RunState } from './types.js';
import { branchName } from './workspace.js';
import { stepCheckout } from './worktree.js';

const exec = promisify(execFile);
type Range = { branch: string; from: string; to: string; source: 'changes' | 'read' | 'copy' };

function ranIn(run: RunState, pass: StepPass): string | undefined {
  const branch = pass.changes?.branch ?? pass.read?.branch;
  const owner = branch === undefined ? undefined : run.copies?.[branch]?.owner;
  return branch !== undefined && owner?.kind === 'local' ? stepCheckout(owner.workspace, branch) : run.checkout;
}

export function evidencePlan(run: RunState, subject: RunSubject) {
  const definitionOf = stepDefinitions(run);
  const all = runPasses(run, agentPassOf);
  const own = all.find((pass) => pass.step === subject.step && pass.pass === subject.pass);
  const workflow = definitionOf(subject.step)?.workflow !== undefined;
  const gaps: EvidenceGap[] = [];
  const under = isUnder(subject.step);
  if (workflow && (run.archive ?? []).some((pass) => under(pass.step) && !pass.within)) gaps.push('children_unattributed');
  const passes = workflow
    ? passesWithin(run, all, subject.step, subject.pass).filter((pass) => definitionOf(pass.step)?.workflow === undefined)
    : own ? [own] : [];
  let diff: Range | undefined = own && passRange(own);
  if (workflow) {
    const branch = branchName(run.id, subject.step, subject.pass);
    const copy = run.copies?.[branch];
    const settled = firstSettled(passes.filter((pass) => passRange(pass) !== undefined));
    const first = settled && passRange(settled);
    if (copy?.commit && first) diff = { branch, from: first.from, to: copy.commit, source: 'copy' };
  }
  const ranges = passes.flatMap((pass): Array<Range & { step: string; pass: number }> => {
    const range = passRange(pass);
    return range ? [{ step: pass.step, pass: pass.pass, ...range }] : [];
  });
  if (diff?.source === 'copy') ranges.unshift({ step: subject.step, pass: subject.pass, ...diff });
  if (!diff && ranges.length === 0) gaps.push('no_recorded_range');
  return { subject, kind: workflow ? 'workflow' : 'prompt', checkout: run.checkout, diff, repoAt: diff?.to ?? ranges.at(-1)?.to, passes, ranges, gaps };
}

async function git(checkout: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: checkout, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 })).stdout;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** `blob` as text, or undefined when it is not UTF-8 text, so it cannot be redacted. */
function textOf(blob: Buffer): string | undefined {
  if (blob.includes(0)) return undefined;
  try {
    return utf8.decode(blob);
  } catch {
    return undefined;
  }
}

/** Writes the tracked files at `commit` into `dir`, redacted; a file that is not text is left out and named in `omitted`. */
async function exportRepo(checkout: string, commit: string, dir: string, omitted: string[], mask: (text: string) => string): Promise<Array<{ title: string; body: string }>> {
  const files = (await git(checkout, ['ls-tree', '-rz', '--full-tree', commit])).split('\0');
  const sections: Array<{ title: string; body: string }> = [];
  for (const file of files) {
    if (!file) continue;
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(file);
    if (!match) continue;
    const [, , type, oid, name] = match;
    if (type !== 'blob' || !oid || !name) continue;
    const target = path.resolve(dir, name);
    if (!target.startsWith(`${dir}${path.sep}`)) throw new Error(`Unsafe tracked path: ${name}`);
    const blob = await exec('git', ['cat-file', 'blob', oid], { cwd: checkout, encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 });
    const text = textOf(blob.stdout);
    if (text === undefined) {
      omitted.push(`repo/${name}`);
      continue;
    }
    const body = mask(text);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
    sections.push({ title: `repo/${name}`, body });
  }
  return sections;
}

/** Evidence is redacted of secret shapes, secret-named env values, and the values of the secrets the team declares. */
export async function buildEvidence(config: LocalConfig, run: RunState, subject: RunSubject, rubrics: Rubrics, dir: string): Promise<{ ok: true } | { ok: false; code: 'evidence_empty' }> {
  if (await isEvidenceReady(dir)) return { ok: true };
  const envSecrets = { ...collectEnvSecrets(), ...await collectTeamSecrets(config) };
  const mask = (text: string): string => redact(text, { envSecrets });
  const plan = evidencePlan(run, subject);
  const gaps = new Set(plan.gaps);
  const sections: Array<{ title: string; body: string }> = [];
  const omitted: string[] = [];
  let content = false;
  await writeEvidence(dir, async (tmp) => {
    const repo = path.join(tmp, 'repo');
    await fs.mkdir(repo);
    if (plan.checkout) {
      try {
        const ranges = plan.diff ? [plan.diff] : plan.ranges;
        const patch = (await Promise.all(ranges.map((range) => git(plan.checkout ?? '', ['diff', '--no-ext-diff', '--no-textconv', range.from, range.to, '--'])))).join('\n');
        if (ranges.length > 0) {
          const body = mask(patch);
          await fs.writeFile(path.join(tmp, 'diff.patch'), body);
          sections.push({ title: 'diff.patch (may include merged dependencies)', body });
          content = true;
        }
        if (plan.repoAt) sections.push(...await exportRepo(plan.checkout, plan.repoAt, repo, omitted, mask));
      } catch {
        gaps.add('commit_missing');
      }
    } else if (plan.repoAt) gaps.add('no_checkout');
    const outputs: Record<string, unknown> = {};
    for (const pass of plan.passes) {
      const name = `${pass.step}#${pass.pass}`;
      if (pass.outputs !== undefined) { outputs[name] = pass.outputs; content = true; }
      const platform = pass.tool && AgentSession.platformForTool(pass.tool);
      if (!pass.session || !platform) { gaps.add('transcript_not_found'); continue; }
      const found = await AgentSession.find({ platform, sessionId: pass.session, cwd: ranIn(run, pass) }, { subagents: true });
      if (found.status !== 'done') { gaps.add('transcript_not_found'); continue; }
      content = true;
      const judged = judgedTranscript(found, { session: SESSION_MAX_CHARS, subagent: SUBAGENT_MAX_CHARS });
      for (const gap of judged.gaps) gaps.add(gap);
      await fs.mkdir(path.join(tmp, 'transcripts'), { recursive: true });
      const body = mask(judged.body);
      await fs.writeFile(path.join(tmp, 'transcripts', `${name}.md`), body);
      sections.push({ title: `transcripts/${name}.md`, body });
    }
    const outputText = mask(JSON.stringify(outputs, null, 2));
    await fs.writeFile(path.join(tmp, 'outputs.json'), outputText);
    if (omitted.length > 0) gaps.add('files_omitted');
    const manifest = {
      subject, kind: plan.kind, ranges: plan.ranges, ...(plan.repoAt ? { repoAt: plan.repoAt } : {}), gaps: [...gaps], ...(omitted.length > 0 ? { omitted } : {}),
    };
    await fs.writeFile(path.join(tmp, 'evidence.json'), JSON.stringify(manifest, null, 2));
    sections.unshift({ title: 'evidence.json', body: JSON.stringify(manifest) });
    sections.push({ title: 'outputs.json', body: outputText });
    await fs.writeFile(path.join(tmp, 'prompt.md'), mask(rubricPrompt(rubrics)) + fencedEvidence(sections, 'diff.patch, repo/, transcripts/, outputs.json and evidence.json'));
  });
  return content ? { ok: true } : { ok: false, code: 'evidence_empty' };
}
