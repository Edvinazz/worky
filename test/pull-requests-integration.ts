import * as vscode from "vscode";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Worky } from "../src/extension";

async function waitFor(check: () => boolean): Promise<void> {
	const end = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() > end)
			throw new Error("Timed out waiting for PR configuration change");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

export async function testPullRequestSetting(worky: Worky): Promise<void> {
	const current = worky.worktreeView.currentPath!;
	const filename = path.join(current, "worky.json");
	const previous = await fs.readFile(filename, "utf8");
	const config = JSON.parse(previous);
	const mainFilename = path.join(worky.repository!.mainPath, "worky.json");
	const mainPrevious = await fs.readFile(mainFilename, "utf8");
	const setEnabled = async (enabled?: boolean) => {
		const next = { ...config };
		if (enabled === undefined) delete next.pullRequests;
		else next.pullRequests = { enabled };
		await fs.writeFile(filename, JSON.stringify(next));
	};
	await worky.refreshPullRequests(true);
	// Keep loads in flight to test disabling and re-enabling while a prior load is settling.
	const internals = worky as unknown as {
		loadPullRequests(signal: AbortSignal): Promise<void>;
	};
	const original = internals.loadPullRequests;
	const calls: { signal: AbortSignal; finish(): void }[] = [];
	internals.loadPullRequests = (signal) =>
		new Promise<void>((finish) => {
			calls.push({ signal, finish });
		});
	const pending = worky.refreshPullRequests(true);
	try {
		await waitFor(() => calls.length === 1);
		worky.pullRequestView.error = "stale error";
		worky.pullRequestView.loading = true;
		worky.pullRequestView.signedIn = true;
		await setEnabled(false);
		await waitFor(() => calls[0]!.signal.aborted);
		assert.equal(worky.pullRequestView.loading, false);
		assert.equal(worky.pullRequestView.signedIn, false);
		assert.equal(worky.pullRequestView.error, undefined);
		assert.deepEqual(worky.pullRequestView.items, []);
		await worky.refresh(true);
		await worky.refreshPullRequests(true);
		// Disabled command handlers must return before requesting authentication or reading PR arguments.
		for (const command of [
			"signIn",
			"openPullRequest",
			"openPullRequestNewWindow",
			"openPullRequestCurrentWindow",
			"openPullRequestOnGitHub",
			"openCurrentPullRequestOnGitHub",
		]) {
			await vscode.commands.executeCommand(`worky.${command}`);
		}
		assert.equal(calls.length, 1, "disabled refreshes do not start loads");
		assert.ok(
			worky.worktreeView.items.length,
			"worktree refresh remains available",
		);
		// The main checkout explicitly disagrees: only the currently open worktree decides.
		await fs.writeFile(
			mainFilename,
			JSON.stringify({
				...JSON.parse(mainPrevious),
				pullRequests: { enabled: false },
			}),
		);
		await setEnabled();
		await waitFor(() => calls.length === 2);
		calls[0]!.finish();
		await pending;
		const current = worky.refreshPullRequests(true);
		assert.equal(
			calls.length,
			2,
			"old completion does not clear the new in-flight load",
		);
		calls[1]!.finish();
		await current;
		// Deleting the file defaults to enabled and never inherits the main checkout's disabled flag.
		await setEnabled(false);
		await waitFor(
			() =>
				calls[1]!.signal.aborted ||
				!(worky as unknown as { pullRequestsEnabled: boolean })
					.pullRequestsEnabled,
		);
		await fs.unlink(filename);
		await waitFor(() => calls.length === 3);
		calls[2]!.finish();
		console.log(
			"Worky PR config integration passed: current checkout, default enabled, live edits/deletion, cancellation, and disabled commands.",
		);
	} finally {
		calls.forEach((call) => call.finish());
		await pending;
		internals.loadPullRequests = original;
		await fs.writeFile(mainFilename, mainPrevious);
		await fs.writeFile(filename, previous);
	}
}
