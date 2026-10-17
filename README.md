# Worky

Manage Git worktrees and GitHub pull requests in VS Code. Works locally and over Remote SSH.

## Features

- Create, open, and delete worktrees, including ones created with Git or other tools.
- Open a worktree in the current VS Code window or a new window.
- Copy a worktree or main checkout to a new branch, preserving staged, unstaged, and untracked changes.
- See your current pull request and PRs awaiting your review; open them on GitHub or in a worktree.
- Automatically run your `worky.json` setup commands for new worktrees, each in its own terminal.
- Open an existing T3 conversation or start a new one for a worktree.
- Collect code snippets with optional comments, edit them as Markdown, and send them together in one T3 message when ready. Supports unsaved files, Git history, and staged changes; saved snippets survive VS Code restarts.

## Get started

Install Worky, open a Git repository, and select **Worky** in the activity bar. For Remote SSH, install the extension on the remote host.

Use **+** or **Worky: Create New Worktree** in the Command Palette. Sign in to GitHub to browse PRs.

Click a worktree or PR to open it in the current window. Enable **Worky: Open In New Window** to change the default. Use the right-click menu to choose a different window option.

## Shortcuts

Available on macOS and Linux.

| Shortcut     | Action                                                          |
| ------------ | --------------------------------------------------------------- |
| Ctrl+Shift+T | Open current worktree's T3 chat                                 |
| Ctrl+Shift+C | Save selected code for a later T3 message                       |
| Ctrl+Shift+V | Send all saved citations (from an editor or the Citations list) |

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

Setup commands run at the same time, each in its own terminal. Add `cwd` to run a command in a subdirectory. You can keep using the terminals after setup finishes.

Configuration comes from the open checkout. New worktrees run setup from their own `worky.json`; without it, no setup runs. Omit `baseBranch` to use the remote default branch.

## T3 Code

The Worktrees header provides **Open Chat** and **New Thread**.

T3 Code is optional. Run its server on the same machine as the repository and add the project to T3. Keep the T3 desktop app connected to open chat links.

## Requirements

Git, VS Code 1.96+, and Bash for setup commands. macOS and Linux are supported.
