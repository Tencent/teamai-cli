#!/usr/bin/env node
/**
 * E2E test runner — pipes input to teamai CLI and verifies output.
 * Usage: node test/e2e.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'dist', 'index.js');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✔ ${msg}`);
    passed++;
  } else {
    console.error(`  ✖ FAIL: ${msg}`);
    failed++;
  }
}

function runCLI(args, stdin = '') {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    child.on('close', (code) => {
      resolve({ code, stdout, stderr, output: stdout + stderr });
    });
  });
}

// ─── Test 1: teamai members — should list members without role tags ──────
async function testMembersList() {
  console.log('\n== Test 1: teamai members — list members without role tags ==');
  const { output } = await runCLI(['members']);
  assert(!output.includes('[write]') && !output.includes('[readonly]'), 'Output does not contain role tags');
  assert(output.includes('jeffyxu'), 'Output contains member username');
  assert(output.includes('(you)'), 'Output contains (you) marker');
  assert(output.includes('Team members'), 'Output contains "Team members" header');
}

// ─── Test 2: teamai members list — same as default members ──────
async function testMembersListSubcommand() {
  console.log('\n== Test 2: teamai members list — subcommand works ==');
  const { output } = await runCLI(['members', 'list']);
  assert(output.includes('jeffyxu'), 'Output contains member username');
  assert(output.includes('Team members'), 'Output contains "Team members" header');
  assert(!output.includes('[write]') && !output.includes('[readonly]'), 'Output does not contain role tags');
}

// ─── Test 3: teamai members add — command no longer triggers add flow ──────
async function testMembersAddRemoved() {
  console.log('\n== Test 3: teamai members add — add flow no longer exists ==');
  const { output } = await runCLI(['members', 'add']);
  // With the add subcommand removed, "members add" falls through to the default
  // list action. The key assertion is that no interactive add flow is triggered.
  assert(!output.includes('Username to add'), 'No "Username to add" prompt appears');
  assert(!output.includes('Role (readonly/write)'), 'No role prompt appears');
  assert(!output.includes('Searching for user'), 'No TGit user search is triggered');
}

// ─── Test 4: init source code — no role, no addMemberDuringInit ──────
async function testInitSourceNoRole() {
  console.log('\n== Test 4: init.ts source — no role in self-registration ==');
  const initSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'init.ts'), 'utf-8');
  assert(!initSrc.includes("role:"), 'init.ts does not set role for self-registration');
  assert(!initSrc.includes('addMemberDuringInit'), 'init.ts does not call addMemberDuringInit');
  assert(!initSrc.includes('Would you like to add team members now'), 'init.ts does not prompt for adding members');
}

// ─── Test 5: members.ts source — no role functions ──────
async function testMembersSourceSimplified() {
  console.log('\n== Test 5: members.ts source — role functions removed ==');
  const membersSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'members.ts'), 'utf-8');
  assert(!membersSrc.includes('requireWriteRole'), 'members.ts does not contain requireWriteRole');
  assert(!membersSrc.includes('addMember'), 'members.ts does not contain addMember');
  assert(!membersSrc.includes('addMemberDuringInit'), 'members.ts does not contain addMemberDuringInit');
  assert(!membersSrc.includes('roleTag'), 'members.ts does not contain roleTag');
  assert(!membersSrc.includes('ROLE_TO_ACCESS_LEVEL'), 'members.ts does not contain ROLE_TO_ACCESS_LEVEL');
  assert(!membersSrc.includes('searchUsers'), 'members.ts does not import searchUsers');
}

// ─── Test 6: tgit-api.ts source — member management APIs removed ──────
async function testTgitApiSimplified() {
  console.log('\n== Test 6: tgit-api.ts source — member management APIs removed ==');
  const tgitSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'tgit-api.ts'), 'utf-8');
  assert(!tgitSrc.includes('searchUsers'), 'tgit-api.ts does not contain searchUsers');
  assert(!tgitSrc.includes('addProjectMember'), 'tgit-api.ts does not contain addProjectMember');
  assert(!tgitSrc.includes('updateProjectMember'), 'tgit-api.ts does not contain updateProjectMember');
  assert(!tgitSrc.includes('TGitSearchUser'), 'tgit-api.ts does not contain TGitSearchUser');
  // Verify retained APIs still exist
  assert(tgitSrc.includes('verifyToken'), 'tgit-api.ts still contains verifyToken');
  assert(tgitSrc.includes('getProject'), 'tgit-api.ts still contains getProject');
  assert(tgitSrc.includes('createProject'), 'tgit-api.ts still contains createProject');
}

// ─── Run all ─────────────────────────────────────────────
async function main() {
  console.log('Running E2E tests for simplified member management...');

  await testMembersList();
  await testMembersListSubcommand();
  await testMembersAddRemoved();
  await testInitSourceNoRole();
  await testMembersSourceSimplified();
  await testTgitApiSimplified();

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
