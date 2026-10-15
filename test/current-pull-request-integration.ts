import * as vscode from "vscode";
import * as assert from "node:assert/strict";
import type { Worky } from "../src/extension";
import type { PullRequest } from "../src/model";
import { git } from "../src/git";

export async function testCurrentPullRequest(worky: Worky): Promise<void> {
	await worky.refresh(true);
	const current = worky.worktreeView.items.find(
		(item) => item.path === worky.worktreeView.currentPath,
	)!;
	const internals = worky as unknown as {
		openPullRequestOnGitHub(pr: PullRequest): Thenable<boolean>;
		updateCurrentWorktreeContext(): void;
		loadPullRequests(signal: AbortSignal): Promise<void>;
	};
	const original = internals.openPullRequestOnGitHub;
	const originalLoad = internals.loadPullRequests;
	const opened: string[] = [];
	internals.openPullRequestOnGitHub = async (pr) => {
		opened.push(pr.url);
		return true;
	};
	const pr: PullRequest = {
		number: 123,
		title: "Current checkout PR",
		url: "https://github.com/example/repo/pull/123",
		author: "test",
		draft: false,
		headBranch: current.branch!,
		headRepository: "example/repo",
		repository: "example/repo",
		headSha: current.head,
		reviewRequested: false,
	};
	try {
		// Keep GitHub deterministic even if a checkout's file watcher requests
		// another refresh. Authentication and HTTP are covered separately.
		internals.loadPullRequests = async (signal) => {
			if (signal.aborted) return;
			worky.pullRequestView.signedIn = true;
			worky.pullRequestView.error = undefined;
			worky.pullRequestView.items = [
				{ ...pr, number: 456, headRepository: "another-owner/repo" },
				pr,
			];
			internals.updateCurrentWorktreeContext();
		};
		await worky.refresh(true);
		assert.equal(worky.worktreeView.currentPullRequest, pr);
		const tooltip = worky.worktreeView.getChildren()[0]!
			.tooltip as vscode.MarkdownString;
		assert.ok(
			tooltip.value
				.replaceAll("&nbsp;", " ")
				.includes("Current checkout PR"),
		);
		assert.ok(tooltip.value.includes("#123"));
		const refreshWorktrees = worky.refreshWorktrees;
		const refreshPullRequests = worky.refreshPullRequests;
		try {
			// A click must use preloaded PRs without waiting for a full status
			// scan or GitHub, even when the PR cache is due for a refresh.
			worky.refreshWorktrees = async () => {
				throw new Error("PR click must not scan worktrees");
			};
			worky.refreshPullRequests = async () => {
				throw new Error("PR click must not wait for GitHub");
			};
			await vscode.commands.executeCommand(
				"worky.openCurrentPullRequestOnGitHub",
			);
		} finally {
			worky.refreshWorktrees = refreshWorktrees;
			worky.refreshPullRequests = refreshPullRequests;
		}
		assert.deepEqual(opened, [pr.url], "opens the current checkout's PR");

		// Change branches without refreshing the UI first: clicking must not open
		// the previous branch's PR from the cache.
		await git(current.path, ["checkout", "-b", "current-pr-no-match"]);
		await vscode.commands.executeCommand(
			"worky.openCurrentPullRequestOnGitHub",
		);
		assert.deepEqual(opened, [pr.url]);
		await worky.refreshWorktrees(true);
		assert.equal(worky.worktreeView.currentPullRequest, undefined);
		await git(current.path, ["checkout", current.branch!]);
		await worky.refreshWorktrees(true);
		assert.equal(worky.worktreeView.currentPullRequest, pr);

		worky.pullRequestView.error = "GitHub unavailable";
		internals.updateCurrentWorktreeContext();
		assert.equal(worky.worktreeView.currentPullRequest, undefined);
		worky.pullRequestView.error = undefined;
		worky.pullRequestView.signedIn = false;
		internals.updateCurrentWorktreeContext();
		assert.equal(worky.worktreeView.currentPullRequest, undefined);
		worky.pullRequestView.signedIn = true;
		worky.pullRequestView.items = [];
		internals.updateCurrentWorktreeContext();
		assert.equal(worky.worktreeView.currentPullRequest, undefined);
		assert.ok(
			!(
				worky.worktreeView.getChildren()[0]!
					.tooltip as vscode.MarkdownString
			).value
				.replaceAll("&nbsp;", " ")
				.includes("Current checkout PR"),
			"removed PRs do not leave stale tooltip details",
		);
		console.log(
			"Worky current PR integration passed: cached browser action without worktree/GitHub refreshes, matching, branch changes, missing PRs, auth/error state, and tooltip refresh.",
		);
	} finally {
		internals.openPullRequestOnGitHub = original;
		internals.loadPullRequests = originalLoad;
		await git(current.path, ["checkout", current.branch!]);
		await worky.refresh(true);
	}
}
