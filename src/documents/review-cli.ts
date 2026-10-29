import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { autoDetectInit } from '../config.js';
import type { SdlcStage } from './artifacts.js';
import { answerReview, assertHumanTerminal, requestReview, requireReviews, reviewHistory } from './reviews.js';

/** A packaged SDLC helper. It records decisions, never executes a development stage. */
export async function documentReview(args = process.argv.slice(2)): Promise<void> {
  try {
    const { values } = parseArgs({ args, options: {
      workspace: { type: 'string' }, task: { type: 'string' }, stage: { type: 'string' },
      request: { type: 'boolean' }, respond: { type: 'string' }, approved: { type: 'boolean' }, history: { type: 'boolean' },
    } });
    if (!values.workspace || !values.task) throw new Error('Pass --workspace and --task.');
    if ([values.request, values.respond !== undefined, values.approved, values.history].filter(Boolean).length !== 1) throw new Error('Choose one of --request, --respond <id>, --approved or --history.');
    const task = { root: process.cwd(), workspace: values.workspace, task: values.task };
    let result: unknown;
    if (values.respond) {
      assertHumanTerminal(process.env, !!process.stdin.isTTY && !!process.stdout.isTTY);
      const { localConfig } = await autoDetectInit();
      const request = (await reviewHistory(task)).find((record) => record.id === values.respond);
      if (!request) throw new Error('Review request not found.');
      console.error(`${request.stage} review ${request.id}\nReviewer: ${localConfig.username}`);
      for (const artifact of request.artifacts) console.error(`${artifact.path}\n  commit: ${artifact.commit}\n  blob: ${artifact.blob}`);
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      let decision: string;
      try { decision = (await terminal.question('Type approve, reject or cancel: ')).trim(); }
      finally { terminal.close(); }
      if (decision !== 'approve' && decision !== 'reject' && decision !== 'cancel') throw new Error('No decision recorded. Type approve, reject or cancel.');
      result = await answerReview(task, values.respond, decision, localConfig.username);
    } else if (values.history) result = await reviewHistory(task);
    else {
      if (!values.stage) throw new Error('Pass --stage intent, spec or plan.');
      result = values.request ? await requestReview(task, values.stage as SdlcStage) : await requireReviews(task, values.stage as SdlcStage);
    }
    console.log(JSON.stringify({ ok: true, result }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
