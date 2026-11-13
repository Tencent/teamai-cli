/**
 * The gates a fleet member's nested run asks the run's owner through the attempt's record, and the answers it takes.
 * Several reads of the record may be in flight at once (the beat's, and the wait for the answer), and a read may act
 * after the member moved on: an answer goes only to the question it answers, once.
 */
import { isDeepStrictEqual } from 'node:util';
import type { ExecAnswer, ExecQuestion } from '@teamai/runtime-protocol/step-runtime';

/** The owner's answer as an `answered` record holds it: the write that holds it, the question it answers, and the answer. */
export type HeardAnswer = { write: string; question: ExecQuestion; answer: ExecAnswer };

export type GateQuestions = {
  /** The question asked and not yet answered, which each progress of the claim carries. */
  readonly asking: ExecQuestion | undefined;
  /** Asks the owner `question`, ending any question still waiting: the owner's answer, or why none comes. */
  ask(question: ExecQuestion): Promise<ExecAnswer>;
  /** Hands `heard`, from a record read at any time, to the question asked when it answers that question. Whether it did. */
  take(heard: HeardAnswer): boolean;
  /** Ends the question asked with `reason`, as no answer comes. */
  refuse(reason: string): void;
};

export function gateQuestions(): GateQuestions {
  let waiting: { question: ExecQuestion; answer: (answer: ExecAnswer) => void } | undefined;
  // The write of the last answer handed: a read that acts late finds it again after the same question was asked anew.
  let heard: string | undefined;

  const end = (answer: ExecAnswer): void => {
    const asked = waiting;
    waiting = undefined;
    asked?.answer(answer);
  };

  return {
    get asking() {
      return waiting?.question;
    },

    ask(question) {
      // One question waits at a time: one still waiting is ended, so its ask does not wait on an answer that never comes.
      end({ refused: 'Another question of the nested run replaced it before the owner answered.' });

      return new Promise<ExecAnswer>((resolve) => {
        waiting = { question, answer: resolve };
      });
    },

    take({ write, question, answer }) {
      if (write === heard || waiting === undefined || !isDeepStrictEqual(waiting.question, question)) return false;
      heard = write;
      end(answer);

      return true;
    },

    refuse(reason) {
      end({ refused: reason });
    },
  };
}
