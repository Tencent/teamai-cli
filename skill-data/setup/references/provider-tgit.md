# Provider: Tencent TGit

git.woa.com is **Tencent-internal only**. TeamAI supports it natively as the `tgit`
provider — it recognizes the host on its own, so you **never** set `GITLAB_URL`.
Both `{SKILL_DIR}/references/setup-admin.md` and
`{SKILL_DIR}/references/join-member.md` point here for the reachability probe and
the `gf` login; follow the relevant section for whichever flow you are in.

## Probe reachability (setup flow only)

When an admin is choosing a platform and hasn't named one, check whether this
machine can reach TGit. A request to git.woa.com that returns the header
`x-env: tgit` means TGit is reachable — plain reachability is not enough,
the header is what confirms it:

```bash
curl -sS -m 3 -D - -o /dev/null https://git.woa.com 2>/dev/null | grep -qi '^x-env:[[:space:]]*tgit' && echo "tgit: OK" || echo "tgit: unreachable"
```

If it prints `tgit: OK`, **prefer TGit** and list it first among the choices — it
is the Tencent-internal default. Choose by account + reachability only, never by
region. (A member joining an existing `git.woa.com` URL skips the probe — the URL
already fixes the platform.)

## Log in: install `gf`, then `gf auth login` — YOU run both

TeamAI drives the TGit CLI (`gf`) on the user's behalf. **Run every command in this
section yourself — both the install and the login. Never tell the user to run a
`gf` command.** The user's only action is approving the login in their browser /
iOA when it opens.

### 1. Install `gf` (you run this)

Use the **same source, path, and check teamai uses** — do not invent your own URL.
`${TEAMAI_HOME}` is `~/.teamai` unless overridden:

```bash
set -eu   # abort on any failure — never fall through to `gf auth login` on a bad install

# pick the tarball for this machine's OS/arch (darwin|linux × x64|arm64)
os=$(uname -s | tr '[:upper:]' '[:lower:]')          # darwin | linux
arch=$(uname -m); [ "$arch" = "x86_64" ] && arch=x64; [ "$arch" = "aarch64" ] && arch=arm64
dir="${TEAMAI_HOME:-$HOME/.teamai}/gf"
url="https://mirrors.tencent.com/repository/generic/gongfeng-cli/files/channels/stable/gf-${os}-${arch}.tar.gz"

# unique temp files per attempt so concurrent/interrupted runs never collide,
# cleaned up on any exit
mkdir -p "$dir"
tmp="$dir/gf-download.$$-$RANDOM"
trap 'rm -f "$tmp.tar.gz" "$tmp.headers"' EXIT

# download over HTTPS, verify sha256, THEN extract (the same safe path teamai
# uses). Fail closed: no advertised digest, or a mismatch, aborts the install.
curl -fsSL -D "$tmp.headers" -o "$tmp.tar.gz" "$url"
# The mirror 302-redirects to a content-addressed backend whose URL path is the
# artifact's sha256; fall back to the x-checksum-sha256 header for direct serves.
expected=$(grep -i '^location:' "$tmp.headers" | grep -oiE '[0-9a-f]{64}' | tail -1 || true)
[ -n "$expected" ] || expected=$(grep -i '^x-checksum-sha256:' "$tmp.headers" | tr -d '\r' | awk '{print $2}' || true)
actual=$( (command -v sha256sum >/dev/null && sha256sum "$tmp.tar.gz" || shasum -a 256 "$tmp.tar.gz") | awk '{print $1}')
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "gf download integrity check FAILED (expected=$expected actual=$actual)" >&2
  exit 1
fi

tar xz -f "$tmp.tar.gz" -C "$dir"
# verify exactly as teamai does: the binary exists and is executable
test -x "$dir/gf/bin/gf"
echo "gf installed OK"
```

Only macOS and Linux, on x64 or arm64, are supported.

### 2. Log in (you run this too — don't hand it to the user)

```bash
"${TEAMAI_HOME:-$HOME/.teamai}/gf/gf/bin/gf" auth login
```

`gf auth login` starts an interactive flow offering three ways to sign in — iOA, a
browser device code, or pasting a token. Pick the browser/iOA option, relay
whatever URL / device code it prints to the user, and ask them to approve it in
their browser — that approval is the *only* thing they do; the command finishes on
its own once they do. Confirm with
`"${TEAMAI_HOME:-$HOME/.teamai}/gf/gf/bin/gf" auth whoami` before continuing.

There is no headless substitute for this step: a `TGIT_TOKEN` Personal Access
Token reaches the git.woa.com REST API only, and the git endpoint rejects it, so
`init` cannot clone with it. Run the login once on the machine (interactively);
later unattended runs reuse the credential it stores.

## When you `teamai init` on TGit

Because `gf` and login are already done, `init` goes straight to creating/cloning —
no browser step. When the repo doesn't exist, **accept the create prompt and init
creates it via the API.** Prefer this over sending the user to the browser first.

It only falls back to https://git.woa.com/projects/new if the group/namespace
doesn't exist or you lack create permission there. No `GITLAB_URL` is ever needed.
