# Children in a sandbox or VM

Read this when your host starts child agents inside a sandbox, a container or a VM, rather than as processes that share this machine's files.

A child changes code only in a place TeamAI prepared or checked: TeamAI commits, pushes and cleans up there with git and the team's delivered files. So the place has to be one that the `teamai` you run can reach.

1. Find where your children's files live:
   - **This machine's filesystem.** The child sees the `dir` its dispatch names. Answer the host question by how your host starts children. The sandbox changes nothing.
   - **Inside the sandbox only.** The child cannot see `dir`. Your host has to create the place itself, and the sandbox has to run the CLI: install `teamai-cli` there, then run `teamai init` with the team repo and `teamai pull`, before you give TeamAI the place's directory. Pick `h3`, whose children work in a worktree your host makes.
   - **Inside a sandbox that cannot run the CLI.** This session cannot run the steps that change code. Tell the person that `teamai workflow cancel <run>` ends this run, and that the local driver can run the workflow from their terminal or CI, as `teamai skill get workflow-local` describes.
2. Run the option's `run`.

Done when the turn it returns has no `choose` action, or the person has the local-driver route.

A worktree is not a sandbox. TeamAI declares no isolation for a skill run, so a step whose workflow requires `isolation: sandbox` still runs, and its `unenforced` lists `isolation`. Tell the person a step ran sandboxed only when your host says so.
