import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, summarize } from './benchmark-assets.mjs';

const trial = (arm, verdict, extra = {}) => ({ task: 'fix', repetition: 1, arm, verdict, durationMs: 20, tokens: null, costUsd: null, ...extra });

void test('unknown usage stays unknown and errors stay in the denominator', () => {
  const report = summarize([trial('before', 'passed'), trial('before', 'error', { repetition: 2 })]);
  assert.deepEqual(report.before, {
    trials: 2, planned: 2, notRun: 0, passed: 1, failed: 0, errors: 1, passRate: 0.5,
    tokens: null, costUsd: null, costPerPassed: null, durationMs: 40,
  });
  assert.equal(report.after.passRate, null);
  assert.equal(report.after.costUsd, null);
});

void test('an interrupted run does not shrink its planned denominator or claim complete costs', () => {
  const report = summarize([trial('before', 'passed', { costUsd: 1, tokens: 10 })], 3);
  assert.equal(report.before.notRun, 2);
  assert.equal(report.before.passRate, 1 / 3);
  assert.equal(report.before.costPerPassed, null);
});

void test('cost per successful task includes the cost of failed attempts', () => {
  const report = summarize([
    trial('after', 'passed', { costUsd: 2, tokens: 10 }),
    trial('after', 'failed', { repetition: 2, costUsd: 3, tokens: 20 }),
  ]);
  assert.equal(report.after.costPerPassed, 5);
  assert.equal(report.after.tokens, 30);
  assert.equal(report.after.passRate, 0.5);
});

void test('pairs only the same task and repetition, independently of run order', () => {
  const pairs = compare([
    trial('after', 'failed'), trial('before', 'passed'),
    trial('before', 'failed', { repetition: 2 }), trial('after', 'passed', { repetition: 2 }),
    trial('before', 'passed', { task: 'other' }), trial('after', 'error', { task: 'other' }),
    trial('before', 'failed', { repetition: 3 }),
  ]);
  assert.deepEqual(pairs.map((pair) => pair.change), ['regressed', 'improved', 'inconclusive', 'inconclusive']);
});
