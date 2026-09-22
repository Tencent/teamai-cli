# Provider: Tencent TGit (工蜂)

git.woa.com is **Tencent-internal only**. TeamAI supports it natively as the `tgit`
provider — it recognizes the host on its own, so you **never** set `GITLAB_URL`.
Both `setup-admin.md` and `join-member.md` point here for the reachability probe
and the `gf` login; follow the relevant section for whichever flow you are in.

## Probe reachability (setup flow only)

When an admin is choosing a platform and hasn't named one, check whether this
machine can reach TGit. A request to git.woa.com that returns the header
`x-env: tgit` means TGit (工蜂) is reachable — plain reachability is not enough,
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
# pick the tarball for this machine's OS/arch (darwin|linux × x64|arm64)
os=$(uname -s | tr '[:upper:]' '[:lower:]')          # darwin | linux
arch=$(uname -m); [ "$arch" = "x86_64" ] && arch=x64; [ "$arch" = "aarch64" ] && arch=arm64
dir="${TEAMAI_HOME:-$HOME/.teamai}/gf"

# download + extract from the Tencent-internal mirror (same URL teamai uses)
mkdir -p "$dir"
curl -fsSL "http://mirrors.tencent.com/repository/generic/gongfeng-cli/files/channels/stable/gf-${os}-${arch}.tar.gz" | tar xz -C "$dir"

# verify exactly as teamai does: the binary exists and is executable
test -x "$dir/gf/bin/gf" && echo "gf installed OK" || echo "gf install FAILED"
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

(Headless/CI only: skip the interactive login and pre-set `TGIT_TOKEN` — a
git.woa.com Personal Access Token — instead.)

## When you `teamai init` on TGit

Because `gf` and login are already done, `init` goes straight to creating/cloning —
no browser step. When the repo doesn't exist, **accept the create prompt and init
creates it via the API.** Prefer this over sending the user to the browser first.

It only falls back to https://git.woa.com/projects/new if the group/namespace
doesn't exist or you lack create permission there. No `GITLAB_URL` is ever needed.
