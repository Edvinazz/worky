import * as vscode from "vscode";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Worky } from "../src/extension";
import type { Worktree } from "../src/model";
import { git } from "../src/git";
import { WorktreeItem } from "../src/views";

export async function testDuplicate(worky: Worky): Promise<void> {
	await worky.refreshWorktrees();
	const repository = worky.repository!;
	const main = worky.worktreeView.items.find((item) => item.main)!;
	const current = worky.worktreeView.items.find(
		(item) => item.path === worky.worktreeView.currentPath,
	)!;
	const internals = worky as unknown as {
		duplicate(source?: Worktree): Promise<void>;
		duplicateBranch(source: Worktree): Promise<string | undefined>;
		openFolder(worktree: Worktree, newWindow: boolean): Promise<void>;
		creating: boolean;
	};
	const originalPrompt = internals.duplicateBranch;
	const originalOpen = internals.openFolder;
	const config = vscode.workspace.getConfiguration("worky");
	const previous = config.inspect<boolean>("openInNewWindow")!.globalValue;
	const opened: { worktree: Worktree; newWindow: boolean }[] = [];
	const created: Worktree[] = [];
	const filename = path.join(main.path, "duplicate-unsaved-test.txt");
	const alias = path.join(
		path.dirname(main.path),
		"duplicate-checkout-alias",
	);
	const aliasFilename = path.join(alias, "duplicate-alias-unsaved-test.txt");
	const realAliasFilename = path.join(
		main.path,
		path.basename(aliasFilename),
	);
	let release: (() => void) | undefined;
	let pending: Thenable<unknown> | undefined;
	try {
		assert.match(new WorktreeItem(main).contextValue!, /duplicable/);
		assert.doesNotMatch(
			new WorktreeItem({ ...main, prunable: "missing" }).contextValue!,
			/duplicable/,
		);
		internals.openFolder = async (worktree, newWindow) => {
			opened.push({ worktree, newWindow });
			created.push(worktree);
		};
		for (const newWindow of [false, true]) {
			await config.update(
				"openInNewWindow",
				newWindow,
				vscode.ConfigurationTarget.Global,
			);
			const source = newWindow ? current : main;
			let prompted = false;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			internals.duplicateBranch = async (selected) => {
				assert.equal(selected.path, source.path);
				prompted = true;
				await gate;
				return newWindow
					? "integration-current-copy"
					: "integration-main-copy";
			};
			pending = newWindow
				? vscode.commands.executeCommand("worky.duplicate")
				: vscode.commands.executeCommand(
						"worky.duplicate",
						new WorktreeItem(source),
					);
			const deadline = Date.now() + 5000;
			while (!prompted && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			assert.ok(prompted);
			assert.equal(
				worky.worktreeView.activity.get(source.path)?.label,
				"Duplicating…",
			);
			assert.equal(
				worky.worktreeView
					.getChildren()
					.find((row) => row.id === source.path)?.contextValue,
				"worktree-busy",
			);
			await vscode.commands.executeCommand(
				"worky.duplicate",
				new WorktreeItem(source),
			);
			release!();
			await pending;
			assert.equal(opened.at(-1)?.newWindow, newWindow);
			const duplicate = opened.at(-1)!.worktree;
			assert.equal(
				(await repository.state.read(duplicate.path))?.setup.status,
				"skipped",
			);
			assert.equal(
				await git(duplicate.path, ["rev-parse", "HEAD"]),
				await git(source.path, ["rev-parse", "HEAD"]),
			);
			assert.equal(worky.worktreeView.activity.size, 0);
			assert.equal(internals.creating, false);
			assert.equal(worky.worktreeView.creating, undefined);
		}
		assert.equal(opened.length, 2);
		internals.duplicateBranch = async () => undefined;
		await vscode.commands.executeCommand(
			"worky.duplicate",
			new WorktreeItem(main),
		);
		assert.equal(
			opened.length,
			2,
			"cancelling the prompt does not create or open a checkout",
		);
		assert.equal(worky.worktreeView.activity.size, 0);
		assert.equal(internals.creating, false);

		await fs.writeFile(filename, "saved\n");
		const document = await vscode.workspace.openTextDocument(filename);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, new vscode.Position(0, 0), "unsaved\n");
		await vscode.workspace.applyEdit(edit);
		assert.equal(document.isDirty, true);
		internals.duplicateBranch = async () => "integration-unsaved-copy";
		await assert.rejects(internals.duplicate(main), /Save the source/);
		assert.equal(worky.worktreeView.activity.size, 0);
		assert.equal(internals.creating, false);
		assert.equal(opened.length, 2);
		await document.save();

		await fs.symlink(main.path, alias, "dir");
		await fs.writeFile(realAliasFilename, "saved through alias\n");
		const aliasDocument =
			await vscode.workspace.openTextDocument(aliasFilename);
		assert.equal(
			aliasDocument.uri.fsPath,
			aliasFilename,
			"the test document must retain its directory alias",
		);
		const aliasEdit = new vscode.WorkspaceEdit();
		aliasEdit.insert(
			aliasDocument.uri,
			new vscode.Position(0, 0),
			"unsaved through alias\n",
		);
		await vscode.workspace.applyEdit(aliasEdit);
		assert.equal(aliasDocument.isDirty, true);
		for (const missing of [false, true]) {
			if (missing) await fs.unlink(realAliasFilename);
			await assert.rejects(internals.duplicate(main), /Save the source/);
			assert.equal(worky.worktreeView.activity.size, 0);
			assert.equal(internals.creating, false);
			assert.equal(
				opened.length,
				2,
				"dirty alias documents must block creation even if the file was deleted",
			);
		}
		await aliasDocument.save();
		console.log(
			"Worky duplication integration passed: main and current checkout commands, window preference, skipped setup, busy guard, cancellation, and unsaved editor protection including directory aliases and deleted files.",
		);
	} finally {
		release?.();
		await pending;
		internals.duplicateBranch = originalPrompt;
		internals.openFolder = originalOpen;
		for (const worktree of created) {
			await git(repository.config.repositoryPath, [
				"worktree",
				"remove",
				"--force",
				"--",
				worktree.path,
			]);
			await git(repository.config.repositoryPath, [
				"branch",
				"-D",
				worktree.branch!,
			]);
			await repository.state.delete(worktree.path);
		}
		await fs.rm(filename, { force: true });
		await fs.rm(realAliasFilename, { force: true });
		await fs.rm(alias, { force: true });
		await config.update(
			"openInNewWindow",
			previous,
			vscode.ConfigurationTarget.Global,
		);
		await worky.refreshWorktrees();
	}
}
