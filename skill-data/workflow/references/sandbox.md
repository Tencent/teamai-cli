# Children in a sandbox or VM

Read this when your host starts child agents inside a sandbox, a container or a VM, rather than as processes that share this machine's files.

A child changes code only in a place TeamAI prepared or checked: TeamAI commits, pushes and cleans up there with git and the team's delivered files. So the place has to be one that the `teamai` you run can reach.

1. Find where your children's files live:
   - **This machine's filesystem.** The child sees the `dir` its dispatch names. Answer the host question by how your host starts children. The sandbox changes nothing.
   - **Inside the sandbox only.** The child cannot see `dir`, and TeamAI adopts only a worktree of this checkout, so this session cannot run the steps that change code. Tell the person that `teamai workflow cancel <run>` ends this run, and that the local driver can run the workflow from their terminal or CI, as `teamai skill get workflow-local` describes.
2. Run the option's `run`.

Done when the turn it returns has no `choose` action, or the person has the local-driver route.

A worktree is not a sandbox. TeamAI declares no isolation for a skill run, so a step whose workflow requires `isolation: sandbox` still runs, and its `unenforced` lists `isolation`. Its dispatch carries `needs.isolation: sandbox`: start that child in a sandbox when your host has one that sees `dir`, and otherwise tell the person the step ran without one. Tell the person a step ran sandboxed only when your host says so.
