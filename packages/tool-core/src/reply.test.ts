import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonValueSchema } from '@teamai/shared/json';
import { extractReply } from './reply.js';

describe('extractReply', () => {
  it.each([
    { reply: '{"answer": 42}', value: { answer: 42 }, case: 'a bare JSON object' },
    { reply: '  \n  {"a": 1}  \n  ', value: { a: 1 }, case: 'whitespace around the JSON' },
    { reply: '"blue"', value: 'blue', case: 'a bare JSON string' },
    { reply: '[1, 2, 3]', value: [1, 2, 3], case: 'a bare JSON array' },
    { reply: '{"nested": {"deep": true}, "list": [1, 2, 3]}', value: { nested: { deep: true }, list: [1, 2, 3] }, case: 'nested objects and arrays' },
    { reply: '```json\n{"fenced": true}\n```', value: { fenced: true }, case: 'a json fence' },
    { reply: '```\n{"bare": true}\n```', value: { bare: true }, case: 'a bare fence' },
    { reply: 'Here is the result:\n```json\n{"verdict":"pass"}\n```', value: { verdict: 'pass' }, case: 'prose before the fence' },
    { reply: '```json\n{"verdict":"pass"}\n```\nLet me know if you need more.', value: { verdict: 'pass' }, case: 'prose after the fence' },
    { reply: 'First try:\n```json\n{"v": 1}\n```\nCorrected:\n```json\n{"v": 2}\n```', value: { v: 2 }, case: 'the last of two fences' },
    { reply: '```json\n{"v": 1}\n```\nAnd the shell I ran:\n```sh\nls -la\n```', value: { v: 1 }, case: 'the last fence that holds JSON' },
    { reply: 'The answer is {"answer": 42}.', value: { answer: 42 }, case: 'an object inline in prose' },
    { reply: 'Draft {"v": 1}, final {"v": 2}.', value: { v: 2 }, case: 'the last object inline in prose' },
    { reply: 'Result: {"note": "a } inside a string", "ok": true} done', value: { note: 'a } inside a string', ok: true }, case: 'a bracket inside a JSON string' },
    { reply: 'Use {braces} like this: {"ok": true}', value: { ok: true }, case: 'prose braces that are not JSON' },
  ])('reads $case', ({ reply, value }) => {
    expect(extractReply(reply, JsonValueSchema)).toEqual(value);
  });

  it.each([
    { reply: 'No structured output here.', case: 'a reply with no JSON' },
    { reply: '', case: 'an empty reply' },
    { reply: '```json\nnot json\n```', case: 'a fence that holds no JSON' },
    { reply: 'Here: {"open": true', case: 'an object that never closes' },
  ])('finds nothing in $case', ({ reply }) => {
    expect(extractReply(reply, JsonValueSchema)).toBeUndefined();
  });

  it('reads a fence written on one line after prose', () => {
    expect(extractReply('Here is the result: ```json {"verdict":"pass"}```', JsonValueSchema)).toEqual({ verdict: 'pass' });
  });

  it('falls back to an earlier value when the schema rejects the last one', () => {
    const Verdict = z.object({ verdict: z.enum(['pass', 'fail']) });

    expect(extractReply('```json\n{"verdict":"pass"}\n```\nFor reference, the input was:\n```json\n{"diff":"retries 3"}\n```', Verdict)).toEqual({ verdict: 'pass' });
  });

  it('skips an empty list or object in the prose, such as a checkbox', () => {
    expect(extractReply('{"color":"blue"}\n- [ ] check the shade', JsonValueSchema)).toEqual({ color: 'blue' });
  });

  it('reads the item of a list the schema accepts when the whole list fails it', () => {
    const Module = z.object({ domain: z.string() });

    expect(extractReply('[{"domain":"widgets"}]', Module)).toEqual({ domain: 'widgets' });
  });

  it('reads a long reply with an unmatched quote in bounded time', () => {
    const started = performance.now();

    expect(extractReply(`${'{ "a '.repeat(40_000)} {"ok": true}`, JsonValueSchema)).toEqual({ ok: true });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('checks the value against the schema it is given', () => {
    const Verdict = z.object({ verdict: z.enum(['pass', 'fail']) });

    expect({
      matches: extractReply('```json\n{"verdict":"pass"}\n```', Verdict),
      fails: extractReply('{"verdict":"maybe"}', Verdict),
      notAnObject: extractReply('"pass"', Verdict),
    }).toEqual({ matches: { verdict: 'pass' }, fails: undefined, notAnObject: undefined });
  });
});
