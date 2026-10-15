import * as vscode from "vscode";
import * as assert from "node:assert/strict";
import type { Worky } from "../src/extension";
import type { PullRequest, Worktree } from "../src/model";
import { pullRequestKey, PullRequestItem, WorktreeItem } from "../src/views";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
	const until = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > until)
			throw new Error("Timed out waiting for row action");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function assertBusy(row: vscode.TreeItem, label: string): void {
	assert.equal((row.iconPath as vscode.ThemeIcon).id, "loading~spin");
	assert.ok(String(row.description).includes(label));
	assert.equal(row.command, undefined, "busy rows cannot be opened again");
	assert.ok(
		row.contextValue?.endsWith("-busy"),
		"busy row actions are hidden",
	);
}

export async function testActions(worky: Worky): Promise<void> {
	const repository = worky.repository!;
	const first: Worktree = {
		path: "/fixture/delete-one",
		head: "abc",
		branch: "delete-one",
		main: false,
		bare: false,
		source: "git",
	};
	const second: Worktree = {
		...first,
		path: "/fixture/delete-two",
		branch: "delete-two",
	};
	const pr: PullRequest = {
		number: 42,
		title: "Test opening",
		url: "",
		author: "test",
		draft: false,
		headBranch: first.branch!,
		headRepository: "example/apps",
		repository: "example/apps",
		headSha: "",
		reviewRequested: false,
	};
	const originalRemove = repository.remove;
	const originalCreate = repository.create;
	const originalItems = worky.worktreeView.items;
	const originalPulls = worky.pullRequestView.items;
	const originalSignedIn = worky.pullRequestView.signedIn;
	const originalCurrentPath = worky.pullRequestView.currentPath;
	const firstGate = deferred();
	const secondGate = deferred();
	let firstCalls = 0;
	let secondCalls = 0;
	const operations: Thenable<unknown>[] = [];
	try {
		worky.worktreeView.items = [...originalItems, first, second];
		worky.pullRequestView.worktrees = worky.worktreeView.items;
		worky.pullRequestView.items = [pr];
		worky.pullRequestView.signedIn = true;
		const activeWorktree = originalItems.find(
			(item) => item.path === originalCurrentPath,
		)!;
		const activePr = {
			...pr,
			number: 7,
			headBranch: activeWorktree.branch!,
			draft: true,
		};
		const reviewPr = {
			...pr,
			number: 8,
			headBranch: "review-requested",
			reviewRequested: true,
		};
		worky.pullRequestView.items = [pr, reviewPr, activePr];
		const rows = () =>
			worky.pullRequestView
				.getChildren()
				.filter((row): row is PullRequestItem => "pullRequest" in row);
		assert.deepEqual(
			rows().map((row) => row.pullRequest.number),
			[7, 8, 42],
			"active PR precedes review requests and other checked-out PRs",
		);
		assert.equal(
			(rows()[0]!.iconPath as vscode.ThemeIcon).id,
			"check",
			"active drafts use the current-worktree icon",
		);
		assert.ok(String(rows()[0]!.description).includes("Current"));
		worky.pullRequestView.currentPath = first.path;
		assert.deepEqual(
			rows().map((row) => row.pullRequest.number),
			[42, 8, 7],
			"changing the current checkout updates PR order",
		);
		assert.equal(
			(rows()[2]!.iconPath as vscode.ThemeIcon).id,
			"git-pull-request-draft",
		);
		worky.pullRequestView.activity.set(pullRequestKey(pr), "Opening…");
		assertBusy(rows()[0]!, "Opening");
		worky.pullRequestView.activity.delete(pullRequestKey(pr));
		worky.pullRequestView.currentPath = originalCurrentPath;
		worky.pullRequestView.items = [pr];
		repository.remove = async (target) => {
			if (target === first.path) {
				firstCalls++;
				await firstGate.promise;
			} else {
				secondCalls++;
				await secondGate.promise;
				throw new Error("Fixture deletion refused");
			}
		};
		operations.push(
			vscode.commands.executeCommand(
				"worky.remove",
				new WorktreeItem(first),
			),
		);
		operations.push(
			vscode.commands.executeCommand(
				"worky.remove",
				new WorktreeItem(second),
			),
		);
		await waitFor(() => firstCalls === 1 && secondCalls === 1);
		for (const worktree of [first, second]) {
			assertBusy(
				worky.worktreeView
					.getChildren()
					.find((row) => row.id === worktree.path)!,
				"Deleting",
			);
		}
		assertBusy(
			worky.pullRequestView
				.getChildren()
				.find((row) => row.id === pullRequestKey(pr))!,
			"Deleting",
		);
		await vscode.commands.executeCommand(
			"worky.remove",
			new WorktreeItem(first),
		);
		await vscode.commands.executeCommand(
			"worky.open",
			new WorktreeItem(first),
		);
		assert.equal(
			firstCalls,
			1,
			"duplicate clicks are ignored while deletion is running",
		);
		firstGate.resolve();
		await operations[0];
		assert.equal(worky.worktreeView.activity.has(first.path), false);
		assert.equal(
			worky.worktreeView.activity.has(second.path),
			true,
			"other deletion remains independently busy",
		);
		assertBusy(
			worky.worktreeView
				.getChildren()
				.find((row) => row.id === second.path)!,
			"Deleting",
		);
		secondGate.resolve();
		await operations[1];
		assert.equal(
			worky.worktreeView.activity.size,
			0,
			"failure clears the busy state",
		);

		// An existing-row open displays activity until its asynchronous work completes.
		const current = worky.worktreeView.items.find(
			(item) => item.path === worky.worktreeView.currentPath,
		)!;
		const opening = worky.open(current);
		assertBusy(
			worky.worktreeView
				.getChildren()
				.find((row) => row.id === current.path)!,
			"Opening",
		);
		await opening;
		assert.equal(worky.worktreeView.activity.size, 0);

		// PR fetch errors clear the spinner and re-enable the row; double clicks don't fetch twice.
		const prGate = deferred();
		let creates = 0;
		repository.create = async () => {
			creates++;
			await prGate.promise;
			throw new Error("Fixture PR fetch failed");
		};
		const openingPr = vscode.commands.executeCommand(
			"worky.openPullRequest",
			new PullRequestItem(pr, []),
		);
		operations.push(openingPr);
		try {
			await waitFor(() => creates === 1);
			assertBusy(
				worky.pullRequestView
					.getChildren()
					.find((row) => row.id === pullRequestKey(pr))!,
				"Opening",
			);
			await vscode.commands.executeCommand(
				"worky.openPullRequest",
				new PullRequestItem(pr, []),
			);
			assert.equal(creates, 1);
		} finally {
			prGate.resolve();
		}
		await openingPr;
		const restored = worky.pullRequestView
			.getChildren()
			.find((row) => row.id === pullRequestKey(pr))!;
		assert.equal(restored.contextValue, "pullRequest");
		assert.equal(restored.command?.command, "worky.openPullRequest");
		console.log(
			"Worky action integration passed: row spinners, concurrent deletion commands, duplicate guards, and error cleanup.",
		);
	} finally {
		firstGate.resolve();
		secondGate.resolve();
		await Promise.allSettled(operations);
		repository.remove = originalRemove;
		repository.create = originalCreate;
		worky.worktreeView.items = originalItems;
		worky.pullRequestView.items = originalPulls;
		worky.pullRequestView.signedIn = originalSignedIn;
		worky.pullRequestView.currentPath = originalCurrentPath;
		await worky.refreshWorktrees();
	}
}
