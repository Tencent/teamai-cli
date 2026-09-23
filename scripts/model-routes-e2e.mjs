import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve('dist/index.js');
assert.ok(fs.existsSync(cli), 'Run npm run build before this end-to-end check');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function run(home, args, status = 0, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cli, 'models', ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, MODEL_TEST_KEY: 'isolated-test-key', ...extraEnv },
    encoding: 'utf8',
  });
  assert.equal(result.status, status, `${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

for (const provider of ['git', 'gitlab', 'github']) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-model-cli-'));
  try {
    const repo = path.join(home, 'team-repo');
    write(path.join(repo, 'teamai.yaml'), `team: HAI Platform\nrepo: https://example.test/team\nprovider: ${provider}\n`);
    write(path.join(repo, 'models', 'models.yaml'), `profiles:
  - id: tokenhub
    name: Tencent TokenHub
    base_url: https://gateway.example.test
    api_key: \${API_KEY}
    model_groups:
      - protocols: [anthropic]
        models:
          - claude-opus-4-8
          - claude-opus-4-6
          - claude-sonnet-4-6
      - protocols: [anthropic, openai-chat-completions]
        models:
          - deepseek-v4-flash
          - glm-5.3
`);
    write(path.join(home, '.teamai', 'config.yaml'), `repo:\n  localPath: ${repo}\n  remote: https://example.test/team\nusername: tester\n`);

    const claude = path.join(home, '.claude', 'settings.json');
    const codex = path.join(home, '.codex', 'config.toml');
    const opencode = path.join(home, '.config', 'opencode', 'opencode.json');
    const codebuddy = path.join(home, '.codebuddy', 'models.json');
    const workbuddy = path.join(home, '.workbuddy', 'models.json');
    write(claude, JSON.stringify({ model: 'personal', env: { KEEP: 'yes' } }));
    write(codex, 'model = "personal"\n# preserve this comment\n');
    write(opencode, JSON.stringify({ model: 'personal/one', provider: { personal: { npm: 'mine' } } }));
    write(codebuddy, JSON.stringify({ models: [{ id: 'personal', name: 'Mine' }] }));
    write(workbuddy, JSON.stringify({ models: [{ id: 'personal', name: 'Mine' }] }));
    const originals = [claude, codex, opencode, codebuddy, workbuddy].map((file) => fs.readFileSync(file, 'utf8'));

    assert.match(run(home, ['list']), /team:tokenhub/);
    run(home, ['configure', 'team:tokenhub', '--from-env', 'MODEL_TEST_KEY']);
    assert.deepEqual([claude, codex, opencode, codebuddy, workbuddy].map((file) => fs.readFileSync(file, 'utf8')), originals);
    const teamFiles = fs.readdirSync(path.join(home, '.teamai', 'models', 'teams'));
    assert.equal(teamFiles.length, 1);
    assert.match(teamFiles[0], /^hai-platform-[a-f0-9]{10}\.json$/);
    assert.deepEqual(readJson(path.join(home, '.teamai', 'models', 'teams', teamFiles[0])), {
      'team:tokenhub': { API_KEY: { env: 'MODEL_TEST_KEY' } },
    });
    assert.match(run(home, ['show', 'team:tokenhub']), /environment MODEL_TEST_KEY/);
    assert.match(run(home, ['switch', 'tokenhub', '--dry-run']), /would switch/);
    assert.deepEqual([claude, codex, opencode, codebuddy, workbuddy].map((file) => fs.readFileSync(file, 'utf8')), originals);
    // Default: every compatible agent. Codex has no Responses route here.
    const switched = run(home, ['switch', 'tokenhub']);
    assert.match(switched, /workbuddy switched to team:tokenhub/);
    assert.doesNotMatch(switched, /codex/);
    assert.deepEqual(readJson(claude).modelPicker.options.map((row) => row.model), [
      'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6', 'deepseek-v4-flash', 'glm-5.3',
    ]);
    assert.equal(readJson(claude).env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-opus-4-8');
    assert.deepEqual(Object.keys(readJson(opencode).provider['teamai-chat'].models), ['deepseek-v4-flash', 'glm-5.3']);
    assert.deepEqual(readJson(codebuddy).models.map((row) => row.id), ['personal', 'deepseek-v4-flash', 'glm-5.3']);
    assert.equal(readJson(codebuddy).models[1].apiKey, '${MODEL_TEST_KEY}');
    assert.deepEqual(readJson(workbuddy).models.map((row) => row.id), ['personal', 'deepseek-v4-flash', 'glm-5.3']);
    assert.equal(fs.readFileSync(codex, 'utf8'), originals[1]);
    assert.match(run(home, ['switch', 'tokenhub', '--agent', 'codex'], 1), /no protocol codex can use/);
    assert.match(run(home, ['list']), /active: claude, opencode, codebuddy, workbuddy/);
    run(home, ['restore']);
    assert.deepEqual(readJson(claude), JSON.parse(originals[0]));
    assert.deepEqual(readJson(opencode), JSON.parse(originals[2]));
    assert.deepEqual(readJson(codebuddy), JSON.parse(originals[3]));
    assert.deepEqual(readJson(workbuddy), JSON.parse(originals[4]));

    const delivered = { model: 'personal', env: {
      ANTHROPIC_BASE_URL: 'https://previous.example.test',
      ANTHROPIC_AUTH_TOKEN: 'previous-token',
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'previous-model',
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Previous Model',
    } };
    write(claude, JSON.stringify(delivered));
    run(home, ['switch', 'tokenhub', '--agent', 'claude'], 0, delivered.env);
    assert.equal(readJson(claude).env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
    run(home, ['restore', '--agent', 'claude']);
    assert.deepEqual(readJson(claude), delivered);
    write(claude, originals[0]);

    run(home, ['add', 'sample-gateway', '--name', 'Sample Gateway', '--protocol', 'openai-responses,openai-chat-completions',
      '--base-url', 'https://gateway.example.test', '--model', 'deepseek-v4-flash,glm-5.3', '--from-env', 'MODEL_TEST_KEY']);
    run(home, ['configure', 'local:sample-gateway', '--protocol', 'anthropic', '--model', 'glm-5.3']);
    run(home, ['switch', 'sample-gateway', '--model', 'glm-5.3']);
    assert.match(fs.readFileSync(codex, 'utf8'), /base_url = "https:\/\/gateway\.example\.test\/v1"/);
    assert.match(fs.readFileSync(codex, 'utf8'), /model = "glm-5.3"/);
    assert.equal(readJson(claude).model, 'glm-5.3');
    assert.deepEqual(readJson(codebuddy).models.map((row) => row.id), ['personal', 'glm-5.3', 'deepseek-v4-flash']);
    run(home, ['restore']);
    assert.deepEqual(readJson(claude), JSON.parse(originals[0]));
    assert.equal(fs.readFileSync(codex, 'utf8').includes('model = "personal"'), true);
    assert.deepEqual(readJson(opencode), JSON.parse(originals[2]));
    assert.deepEqual(readJson(codebuddy), JSON.parse(originals[3]));
    assert.deepEqual(readJson(workbuddy), JSON.parse(originals[4]));
    write(codex, '"model" = "personal" # keep model note\n\'model_provider\' = "custom" # keep provider note\n');
    run(home, ['switch', 'local:sample-gateway', '--agent', 'codex']);
    assert.match(fs.readFileSync(codex, 'utf8'), /"model" = "deepseek-v4-flash" # keep model note/);
    run(home, ['restore', '--agent', 'codex']);
    assert.match(fs.readFileSync(codex, 'utf8'), /'model_provider' = "custom" # keep provider note/);
    write(codex, originals[1]);
    run(home, ['remove', 'local:sample-gateway']);
    assert.match(run(home, ['list']), /team:tokenhub/);
    console.log(`Model route CLI end-to-end passed for ${provider}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
