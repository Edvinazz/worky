# Worky

Manage Git worktrees and GitHub pull requests in VS Code. Works locally and over Remote SSH.

## Features

- Create, open, and delete worktrees, including those created by other tools.
- Duplicate any checkout, including the main checkout, with its staged edits, unstaged edits, and untracked files.
- Open a PR in its existing worktree or create one for it.
- Open the current worktree's PR on GitHub using the pull-request button beside the chat actions in the Worktrees header. Hover the current worktree to see its PR number and title. The button is disabled when no open PR matches and hidden when the checkout disables PR features.
- See the current PR first, followed by PRs requesting your review.
- Run setup commands in parallel, interactive terminals for new worktrees.
- Open an existing T3 Code chat or start a new thread for your checkout.

## Get started

Install Worky, open a Git repository, and select **Worky** in the activity bar. For Remote SSH, install the extension on the remote host.

Use **+** or **Worky: Create New Worktree** in the Command Palette. Sign in to GitHub to browse PRs.

Click a worktree or PR to open it in the current window. Enable **Worky: Open In New Window** to change the default; the row button and right-click menu offer the opposite action.

## Setup

Optionally commit a `worky.json` file at the repository root:

```json
{
	"baseBranch": "main",
	"setup": [
		{
			"name": "Setup",
			"command": "npm install"
		}
	]
}
```

Each command gets its own terminal. Add `cwd` to run it in a subdirectory. Terminals remain interactive when commands finish.

Configuration comes from the open checkout. New worktrees run setup from their own `worky.json`; without it, no setup runs. Omit `baseBranch` to use the remote default branch.

To disable PR features for a checkout, add `"pullRequests": { "enabled": false }` to its config.

## T3 Code

The Worktrees header provides **Open Chat** and **New Thread**. On macOS, **Control+Shift+T** opens chat.

T3 Code is optional. Its server must run on the workspace machine, with the repository registered and a desktop client that supports thread links connected to it.

## Requirements

Git, VS Code 1.96+, and Bash for setup commands. macOS and Linux are supported.
