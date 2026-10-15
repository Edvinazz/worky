import * as vscode from "vscode";
import * as assert from "node:assert/strict";
import type { Worky } from "../src/extension";
import type { Worktree, PullRequest } from "../src/model";
import { WorktreeItem, PullRequestItem } from "../src/views";

async function waitFor(check: () => boolean): Promise<void> {
	const end = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > end)
			throw new Error("Timed out waiting for current-worktree action");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

export async function testWorkspaceActions(worky: Worky): Promise<void> {
	await worky.refresh(true);
	const config = vscode.workspace.getConfiguration("worky");
	const previous = config.inspect<boolean>("openInNewWindow")!.globalValue;
	assert.equal(
		config.get("openInNewWindow"),
		false,
		"normal clicks reuse the window by default",
	);
	const internals = worky as unknown as {
		openFolder(worktree: Worktree, newWindow: boolean): Promise<void>;
		checkoutPullRequest(
			item: PullRequestItem,
			newWindow: boolean,
			alreadyBusy: boolean,
		): Promise<void>;
		openInT3(worktree: Worktree, newThread?: boolean): Promise<void>;
		withWorktreeActivity(
			worktree: Worktree,
			label: string,
			action: () => Promise<void>,
		): Promise<void>;
	};
	const originalFolder = internals.openFolder;
	const originalCheckout = internals.checkoutPullRequest;
	const originalChat = internals.openInT3;
	const windows: boolean[] = [];
	const prWindows: boolean[] = [];
	const threads: { worktree: Worktree; newThread: boolean }[] = [];
	const current = worky.worktreeView.items.find(
		(item) => item.path === worky.worktreeView.currentPath,
	)!;
	const other = worky.worktreeView.items.find(
		(item) => item.path !== current.path,
	)!;
	const pr: PullRequest = {
		number: 999,
		title: "Window preference",
		url: "",
		author: "test",
		draft: false,
		headBranch: "unopened-pr",
		headRepository: "example/repo",
		repository: "example/repo",
		headSha: "",
		reviewRequested: false,
	};
	let finishChat: (() => void) | undefined;
	internals.openFolder = async (_worktree, newWindow) => {
		windows.push(newWindow);
	};
	internals.checkoutPullRequest = async (_item, newWindow) => {
		prWindows.push(newWindow);
	};
	// T3's reuse/create behavior is covered by its client tests; keep desktop links out of this fixture.
	internals.openInT3 = (worktree, newThread = false) =>
		internals.withWorktreeActivity(worktree, "Opening in T3…", async () => {
			threads.push({ worktree, newThread });
			await new Promise<void>((resolve) => {
				finishChat = resolve;
			});
		});
	try {
		assert.equal(
			worky.worktreeView.getChildren()[0]!.id,
			current.path,
			"current worktree sorts before the main checkout",
		);
		for (const newWindow of [false, true]) {
			await config.update(
				"openInNewWindow",
				newWindow,
				vscode.ConfigurationTarget.Global,
			);
			const row = new WorktreeItem(other);
			const pull = new PullRequestItem(pr, []);
			await vscode.commands.executeCommand("worky.open", row);
			await vscode.commands.executeCommand(
				newWindow ? "worky.openCurrentWindow" : "worky.openNewWindow",
				row,
			);
			await vscode.commands.executeCommand("worky.openPullRequest", pull);
			await vscode.commands.executeCommand(
				newWindow
					? "worky.openPullRequestCurrentWindow"
					: "worky.openPullRequestNewWindow",
				pull,
			);
		}
		assert.deepEqual(windows, [false, true, true, false]);
		assert.deepEqual(prWindows, [false, true, true, false]);

		for (const [command, newThread] of [
			["worky.openCurrentInT3", false],
			["worky.newCurrentT3Thread", true],
		] as const) {
			const count = threads.length;
			const pending = vscode.commands.executeCommand(command);
			try {
				await waitFor(() => threads.length === count + 1);
				assert.equal(threads.at(-1)!.worktree.path, current.path);
				assert.equal(threads.at(-1)!.newThread, newThread);
				const row = worky.worktreeView.getChildren()[0]!;
				assert.equal(row.contextValue, "worktree-busy");
				assert.equal(
					(row.iconPath as vscode.ThemeIcon).id,
					"loading~spin",
				);
				// A second action on the same current checkout does not start another thread operation.
				await vscode.commands.executeCommand("worky.openCurrentInT3");
				assert.equal(threads.length, count + 1);
			} finally {
				finishChat?.();
			}
			await pending;
			assert.equal(worky.worktreeView.getChildren()[0]!.id, current.path);
			assert.equal(
				worky.worktreeView.getChildren()[0]!.command?.command,
				"worky.open",
			);
		}
		console.log(
			"Worky workspace actions integration passed: window defaults and overrides, current checkout, chat/new-thread dispatch, spinners, and duplicate guards.",
		);
	} finally {
		finishChat?.();
		internals.openFolder = originalFolder;
		internals.checkoutPullRequest = originalCheckout;
		internals.openInT3 = originalChat;
		worky.worktreeView.currentPath = current.path;
		await config.update(
			"openInNewWindow",
			previous,
			vscode.ConfigurationTarget.Global,
		);
		await worky.refreshWorktrees();
	}
}
