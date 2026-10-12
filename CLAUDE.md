# claude-usage-bar

Public repository, distributed on GitHub: https://github.com/Digital3D/claude-usage-bar

## Language: English everywhere, commit messages included

Everything in this repository is written in English: code, comments, identifiers, UI labels, toasts,
README, and **commit messages and pull requests**.

This overrides the global `~/.claude/CLAUDE.md`, which asks for commit messages in French. That rule
does not apply here. Replies to David in the session stay in French.

## Commits

- Author identity: `Digital3D <noreply@digital3d.com>`, set in the local git config of the clone
  (`git config --local user.name` / `user.email`). GitHub rejects a push whose commits carry a personal
  address ("push declined due to email privacy restrictions").
- No mention of Claude or AI in a commit or a pull request.
- Never push without a fresh authorization from David.

## Build and tests

```bash
claude plugin validate usage-bar
claude plugin test usage-bar
```

`check.ps1` runs both. Types are not compiled by these commands.

## Scope

This is the simplified, public version of David's private mod (`~/.claude/mods/usage-bar`, French
labels, more features). A rule changed in one is usually to be carried over to the other.
