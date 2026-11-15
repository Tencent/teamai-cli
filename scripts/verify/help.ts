/** The harness's help: the basic page, with one line per topic, and each topic's page. */
import { ORIGIN_URL } from './members.js';
import { CANARY_NAME, TEAM_URL } from './world.js';

const BASIC = `Verify a teamai change end to end: the real CLI, packed and installed, in an isolated world.

  npm run verify:world                        build, pack, create a world; print its run id alone on stdout
  npm run -s verify -- doctor [run]           node, git and each tool on PATH; whether the world matches the checkout
  npm run -s verify -- teamai <run> <args>    the world's installed teamai, in its project
  npm run -s verify -- sh <run> <cmd> [args]  any command in the world (git, claude -p, a second checkout)
  npm run -s verify -- ledger <run>           uninstall teamai in the world, then what is left, in LEDGER-<n>.md; exit 1 on any LEAK
  npm run -s verify -- cleanup <run>|--all    remove the world and the containers and sandboxes it left, keeping world.json,
                                              logs/ and every ledger; refuses while a process of the world runs or a place of
                                              its attempts is still open, or the check for either fails
  npm run -s verify -- dir <run>|--all        the world's directory, or every live world

A world holds a project repo with one commit, a bare team repo at ${TEAM_URL}, the npm pack tarball of
this checkout installed on its own (built in the world's pkg/, never in the checkout's dist/, which an E2E run may
be loading), a HOME and TMPDIR of its own, and a fake gh first on PATH: \`gh pr list\`
prints fakes/gh-pr-list.json or [], anything else fails as when gh is not signed in, and each call goes to
fakes/gh.log. Commands get an environment built from nothing: no tool home (CLAUDE_CONFIG_DIR, CODEX_HOME, ...)
or TEAMAI_* variable of your shell reaches them. Set one on the command line when the claim needs it: \`sh <run> env CODEX_HOME=... teamai pull\`.

A world freezes the build it was made from. Change teamai and the next proof needs a new world; doctor warns when
the checkout has moved on. Start from \`teamai init ${TEAM_URL} --provider git --agent claude\`.

A command that asks a question, such as accepting a team tool, needs a terminal: with none it runs unattended and
refuses. \`script -q /dev/null teamai <args>\` gives it one on macOS, \`script -q -c 'teamai <args>' /dev/null\` on Linux.
Write y and a newline to its input only once the question is in its output: an answer sent earlier, or without the
newline, leaves the run waiting, and an input at end of file (< /dev/null) ends it interrupted.

Use the real tool on its cheapest model (claude -p --model haiku; \`doctor --drivers\` names each tool's). A faked tool
proves the fake. A tool that is not installed or not signed in here makes the claim UNVERIFIABLE, not passed.

Verdicts, reported with the combination and entry point (VERIFIED: claude x git x project scope via teamai pull):
  VERIFIED      every observable matched and the ledger is CLEAN
  FAILED        an observable did not match, or the ledger found a LEAK; quote the output
  UNVERIFIABLE  a prerequisite is missing (a tool, a sign-in, Windows), or a part says NOT OBSERVED; name it
The ledger ends CLEAN only when it found no LEAK and observed every part. \`no LEAK, <n> NOT OBSERVED\` exits 0, and
leaves the claim UNVERIFIABLE for each part a NOT OBSERVED line names: such a world proves nothing there. It exits 0
because NOT OBSERVED is what the harness could not look at, as the content of an entry that was there before the run
(another user's folder the run never touched) or a stopped container engine: failing on it would fail every run on such
a host, and the verdict counts it.
A fix is proved by a pair: FAILED in a world built from main, VERIFIED in a world built from the change.

Run ledger after the last run, before cleanup. It uninstalls teamai, which removes the run records under the world's
HOME: read what a claim needs from a run's record first. Paste the verdict, the commands, build.json's line from the
run's first output, and the ledger's last line into the PR's real-CLI record.

More:
  npm run -s verify -- help drivers           where a step runs: each driver's entry point and the end state that proves
                                              it; doctor --drivers, and reap for the Vercel sandboxes teamai left alive
  npm run -s verify -- help fleet             two members, an origin, and a member on another machine: member, origin
  npm run -s verify -- help keys              passing a key to one command without it reaching a log: --pass`;

const DRIVERS = `Where a step runs. A driver claim names the driver and proves its end state below, with the ledger CLEAN.
A ledger section or an observer line that says NOT OBSERVED proves nothing for that part: the claim is UNVERIFIABLE there.
\`doctor --drivers\` says which providers this machine has, and which host commands each step runtime runs.

  local     teamai <run> workflow start <wf> --driver local
            ends: the run's outcome; (f) no world process left, no open attempt place left
  host      the command slot teamai adds to every definition: a command step on any driver runs there
            ends: as local, the step's exit in the run record
  skill     a coding session drives the run: teamai <run> workflow start <wf> --driver skill, then next and report
            ends: the run settled through report; the session's tool is the real one on its cheapest model
  fleet     see \`help fleet\`
  T3        teamai <run> workflow start <wf> --driver teamai-t3 (t3 on PATH)
            ends: a thread per prompt step; (f) no open attempt place left
  Paseo     teamai <run> --pass PASEO_HOME workflow start <wf> --driver teamai-paseo (paseo on PATH)
            ends: an agent per prompt step; (f) no open attempt place left. Without --pass PASEO_HOME the runtime
            reads the daemon's address from, and adds its providers to, <world>/home/.paseo/config.json, which no
            daemon reads; with it, they land in your Paseo home's config.json, which you restore after the run
  sandbox   teamai <run> workflow start <wf> --driver <a driver whose entry is use: sandbox>, with a profile per provider
    docker, podman  a container per attempt, labelled teamai.owner; ends: an observer line env ok per container,
                    (f) no teamai container left. An engine that is installed but not running is NOT OBSERVED in
                    (f), since its stopped containers and images outlive it: start it before the ledger
    sbx             a microVM per attempt named teamai-<journal>-...; needs sbx signed in and a policy that lets the
                    step reach what it needs; ends: env ok, (f) no teamai sbx sandbox or template left. A
                    world's HOME starts signed out: \`doctor <run> --drivers\` says so, and \`sh <run> sbx login\`
                    signs in there. Until then a sbx claim is UNVERIFIABLE
    bwrap           Linux only; the observer reads the first process under bwrap; ends: env ok, no world process left
    seatbelt        macOS; no observer reads a seatbelt step's environment, so the env part proves nothing for it,
                    and (f) says NOT OBSERVED for each attempt that ran on it
    vercel          remote; the ledger never asks it: \`reap [run] [--delete] [vercel:<name>...]\` with the key lists
                    each sandbox teamai made there and whose it is, deletes the world's own or a named one on --delete,
                    exits 0 once none is alive, and says UNVERIFIABLE without a key

The observer: a teamai or sh command during which a sandbox opens or closes ends with one line per sandbox of the world
it saw, \`[verify] observed <sandbox>: env ok\`, \`ENV LEAK <names>\` or NOT OBSERVED when it could not read one, kept in
observed.jsonl. A sandbox can close before the observer's first look, and then has no line: (f) says NOT OBSERVED for
each sandboxed attempt whose environment no line of observed.jsonl read, whatever its provider. A leak is the world's
canary (${CANARY_NAME}, which no step may receive) or a host secret no driver definition declares. Names only, ever.
An entry that declares no credential gets the tool's sign-in variables from the command's environment by name, as
docs/guide/workflow-advanced.md says, so env ok also holds when a step carried one.

A claim teamai decides by hostname or pid (a driver's identity, the owner of a staging folder, the import lock, a warm
image's maker, the fleet's stop of a step whose starter is gone) needs \`member <run> <name> --machine container\`: two
members on one Mac share a hostname and a process table.

Platforms: macOS and Linux. Windows has no world; WSL2 counts as Linux and is the way to run one from a Windows machine,
UNVERIFIED until someone runs it there.`;

const FLEET = `Two members and an origin.

  npm run -s verify -- member <run> <name> [--machine container]
                                              a second install with its own HOME, TMPDIR and clone
  npm run -s verify -- origin <run>           give the world's project a bare origin at ${ORIGIN_URL}

\`member <run> bob\` gives the world's project its origin the first time; \`origin <run>\` does that alone.
<run>@bob acts as bob in every verb: teamai, sh, dir, ledger and cleanup cover every member whichever one names the world.

  owner     teamai <run> workflow start <wf> --driver <a driver whose entry is use: fleet>
  member    teamai <run>@bob workflow resume --next --pool <pool>
  cancel    teamai <run>@bob workflow cancel <run id>, or from the owner
  ends:     the attempt finished or cancelled in teamai-reports; the ledger CLEAN for every member, with each ref
            teamai moved on the origin listed as a note

A member on another machine: \`member <run> carol --machine container\` runs carol in a Linux container of their own, with
a hostname and process table of their own and the world's packed teamai installed in it. Carol's verbs go through docker exec with
each variable by name; the ledger reads carol's processes from /proc, and cleanup removes the container by name. Docker
must be up; the first one builds the image teamai-verify-machine:node<major>, which every world shares, so cleanup keeps
it: \`docker image rm teamai-verify-machine:node<major>\` removes it once no world has a container member.`;

const KEYS = `A key reaches one command only when you pass it, by name: \`sh <run> --pass NAME[,NAME...] <cmd>\` or
\`teamai <run> --pass NAME ...\` copies those variables from your shell into that command's environment.
Its output in the terminal and in logs/ shows each passed value, and each secret-looking value of your shell, as
<REDACTED:NAME>. The ledger masks each name the world's commands were given that your shell still sets, and names any
it does not (world.json keeps the names, never a value), so run it with the same keys exported. A value typed on the
command line is not passed: it lands in logs/ as typed.
\`doctor --drivers\` lists the keys your shell holds, by name.
Prove a run kept a key out: \`grep -rF -c "$VALUE" <world> /tmp/teamai-verify-<run>*\` with a dummy value you made counts
0 under the world's directory and each TMPDIR of the world. Count before cleanup: it removes the TMPDIRs.`;

const TOPICS = { drivers: DRIVERS, fleet: FLEET, keys: KEYS } as const;

/** The help page `topic` names, or the basic page with the topics listed. */
export function helpFor(topic: string | undefined): string {
  if (topic === undefined) return BASIC;

  return Object.entries(TOPICS).find(([name]) => name === topic)?.[1] ?? `No help topic ${topic}.\n\n${BASIC}`;
}
