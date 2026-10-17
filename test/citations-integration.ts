import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import type { Worky } from "../src/extension";
import type { Citations } from "../src/citations";
import type { CodeCitation } from "../src/citation";
import type {
	T3Client,
	T3CitationRequest,
	T3CitationSelection,
} from "../src/t3";
import type { Worktree } from "../src/model";
import { git } from "../src/git";
import { CitationStore } from "../src/citation-store";

export async function testCitations(worky: Worky): Promise<void> {
	const internal = worky as unknown as {
		citations: Citations;
		notifications: { item: vscode.StatusBarItem };
		t3Client(): T3Client;
	};
	const controller = internal.citations;
	const files = (
		controller as unknown as {
			files: {
				baselines: Map<string, string>;
				confirmRestoredDraft(): Promise<boolean>;
			};
		}
	).files;
	const originalRestoreConfirmation = files.confirmRestoredDraft;
	const prompt = controller as unknown as {
		askComment(
			citation: CodeCitation,
			value?: string,
		): Promise<string | undefined>;
		askInstruction(
			count: number,
			target?: string,
		): Promise<string | undefined>;
		pickThread(
			items: (vscode.QuickPickItem & {
				selection: T3CitationSelection;
			})[],
		): Promise<
			| (vscode.QuickPickItem & { selection: T3CitationSelection })
			| undefined
		>;
	};
	const originalPrompt = prompt.askComment;
	const originalInstruction = prompt.askInstruction;
	const originalPicker = prompt.pickThread;
	const originalClient = internal.t3Client;
	const root = worky.worktreeView.currentPath!;
	const store = new CitationStore(worky.repository!.state, root);
	const filename = path.join(root, "citation-fixture.ts");
	await fs.writeFile(
		filename,
		"const first = 1;\nconst selected = 2;\nconst last = 3;\n",
	);
	const document = await vscode.workspace.openTextDocument(filename);
	let editor = await vscode.window.showTextDocument(document);
	await editor.edit((edit) =>
		edit.replace(
			new vscode.Range(1, 0, 1, document.lineAt(1).text.length),
			"const unsaved = 42;",
		),
	);
	editor.selection = new vscode.Selection(1, 0, 2, 0);
	const calls: { worktree: Worktree; request: T3CitationRequest }[] = [];
	let fail = false;
	try {
		internal.t3Client = () => {
			throw new Error("Collecting must work with T3 offline");
		};
		const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
			"vscode.executeHoverProvider",
			document.uri,
			new vscode.Position(1, 5),
		);
		assert.ok(
			!hovers?.some((item) =>
				item.contents.some(
					(content) =>
						typeof content === "object" &&
						"value" in content &&
						content.value.includes("command:worky.cite?"),
				),
			),
		);
		prompt.askComment = async (citation) => {
			assert.equal(citation.file, "citation-fixture.ts");
			assert.equal(citation.code, "const unsaved = 42;\n");
			assert.equal(citation.unsaved, true);
			editor.selection = new vscode.Selection(0, 0, 0, 3);
			await editor.edit((edit) =>
				edit.insert(new vscode.Position(0, 0), "// later edit\n"),
			);
			return "Please explain this";
		};
		await vscode.commands.executeCommand("worky.cite");
		assert.equal((await store.read()).items.length, 1);
		assert.ok(
			(await store.read()).items[0]!.markdown.includes(
				"```typescript\nconst unsaved = 42;\n```",
			),
		);
		assert.ok(!(await fs.readFile(filename, "utf8")).includes("unsaved"));
		editor.selection = new vscode.Selection(0, 0, 0, 3);
		prompt.askComment = async () => "second citation";
		await vscode.commands.executeCommand("worky.cite", document.uri);
		assert.equal(controller.getCitations().length, 2);
		assert.equal(calls.length, 0);
		const first = controller.getCitations()[0]!;
		await vscode.commands.executeCommand("worky.editCitation", first);
		const draftEditor = vscode.window.activeTextEditor!;
		assert.equal(draftEditor.document.languageId, "markdown");
		const editedMarkdown =
			"Edited message\n\n```typescript\nconst edited = 99;\n```\n";
		assert.ok(
			await draftEditor.edit((edit) =>
				edit.replace(
					new vscode.Range(0, 0, draftEditor.document.lineCount, 0),
					editedMarkdown,
				),
			),
		);
		assert.ok(await draftEditor.document.save());
		assert.equal((await store.read()).items[0]!.markdown, editedMarkdown);
		// Simulate hot-exit restoring a dirty editor in a fresh provider instance.
		assert.ok(
			await draftEditor.edit((edit) =>
				edit.insert(new vscode.Position(0, 0), "Restored draft\n"),
			),
		);
		files.baselines.clear();
		let restoreConfirmations = 0;
		files.confirmRestoredDraft = async () => {
			restoreConfirmations++;
			return true;
		};
		assert.ok(
			await draftEditor.document.save(),
			"restored dirty draft can be explicitly recovered",
		);
		assert.equal(restoreConfirmations, 1);
		assert.ok(
			(await store.read()).items[0]!.markdown.startsWith(
				"Restored draft\n",
			),
		);
		assert.ok(
			await draftEditor.edit((edit) =>
				edit.delete(new vscode.Range(0, 0, 1, 0)),
			),
		);
		assert.ok(await draftEditor.document.save());

		assert.ok(
			await draftEditor.edit((edit) =>
				edit.insert(new vscode.Position(0, 0), "Unsaved draft edit\n"),
			),
		);
		assert.ok(draftEditor.document.isDirty);
		editor = await vscode.window.showTextDocument(document);
		prompt.askComment = async () => undefined;
		await vscode.commands.executeCommand("worky.cite");
		assert.equal(
			(await store.read()).items.length,
			2,
			"cancel does not collect",
		);
		prompt.askInstruction = async () => undefined;
		await vscode.commands.executeCommand("worky.sendCitations");
		assert.equal(
			(await store.read()).pending,
			undefined,
			"cancel does not prepare a send",
		);
		assert.equal(
			(internal.notifications.item.command as vscode.Command).command,
			"worky.sendCitations",
			"a failed offline preflight must offer a fresh send, not a nonexistent retry",
		);
		internal.t3Client = () =>
			({
				citationChoices: async () => ({
					origin: "http://127.0.0.1:3773",
					environmentId: "test",
					threads: [
						{ id: "recent", title: "Most recent conversation" },
						{ id: "older", title: "Earlier conversation" },
					],
				}),
				sendCitation: async (
					worktree: Worktree,
					_main: string,
					request: T3CitationRequest,
					checkpoint: () => Promise<void>,
				) => {
					request.target ??= {
						threadId: "test-thread",
						environmentId: "test",
						created: false,
						url: "t3code://threads/test/test-thread",
					};
					await checkpoint();
					calls.push({ worktree, request: structuredClone(request) });
					if (fail) throw new Error("Fixture lost acknowledgement");
					return { target: request.target, delivery: "queued" };
				},
			}) as unknown as T3Client;
		prompt.pickThread = async (items) => {
			assert.equal(items[0]!.label, "Most recent conversation");
			assert.equal(items[0]!.picked, true);
			assert.equal(items.at(-1)!.selection.kind, "new");
			return items[1];
		};
		await vscode.commands.executeCommand("worky.selectCitationThread");
		assert.equal((await store.read()).selection?.threadId, "older");
		assert.ok(
			controller
				.getTreeItem(controller.getChildren()[0]!)
				.label?.toString()
				.includes("Earlier conversation"),
		);
		prompt.pickThread = async (items) => items.at(-1);
		await vscode.commands.executeCommand("worky.selectCitationThread");
		assert.equal((await store.read()).selection?.kind, "new");
		assert.equal(
			calls.length,
			0,
			"selecting New thread does not create or send",
		);
		prompt.pickThread = async () => undefined;
		await vscode.commands.executeCommand("worky.selectCitationThread");
		assert.equal(
			(await store.read()).selection?.kind,
			"new",
			"cancel preserves destination",
		);

		prompt.askInstruction = async () => {
			const draft = await vscode.window.showTextDocument(
				draftEditor.document,
			);
			assert.ok(
				await draft.edit((edit) =>
					edit.insert(
						new vscode.Position(draft.document.lineCount, 0),
						"\nAdded while the send prompt was open.\n",
					),
				),
			);
			return "Do not send the earlier version";
		};
		await vscode.commands.executeCommand("worky.sendCitations");
		assert.equal(
			calls.length,
			0,
			"changed drafts require another send decision",
		);
		assert.equal((await store.read()).pending, undefined);
		assert.ok(
			(await store.read()).items[0]!.markdown.includes(
				"Added while the send prompt was open.",
			),
		);
		assert.equal(
			draftEditor.document.isDirty,
			false,
			"prompt-time edits were saved",
		);

		prompt.askInstruction = async (count, target) => {
			assert.equal(count, 2);
			assert.equal(target, "New thread");
			return "Explain these together";
		};
		fail = true;
		await vscode.commands.executeCommand("worky.sendCitations");
		assert.equal(calls.length, 1);
		assert.equal(
			(internal.notifications.item.command as vscode.Command).command,
			"worky.retryCitation",
			"uncertain delivery offers the durable retry",
		);
		assert.equal(calls[0]!.request.selection?.kind, "new");
		await assert.rejects(controller.selectThread(), /pending batch/);
		assert.equal(calls[0]!.worktree.path, root);
		assert.ok(
			calls[0]!.request.text.startsWith(
				"Explain these together\n\n## Citation 1",
			),
		);
		assert.ok(calls[0]!.request.text.includes("## Citation 2"));
		assert.ok(
			calls[0]!.request.text.includes(
				"Unsaved draft edit\n" + editedMarkdown,
			),
			"Send All saves and includes editable Markdown",
		);
		assert.ok(!draftEditor.document.isDirty);
		await vscode.window.showTextDocument(draftEditor.document);
		await vscode.commands.executeCommand(
			"workbench.action.closeActiveEditor",
		);
		editor = await vscode.window.showTextDocument(document);
		assert.equal(
			(await new CitationStore(worky.repository!.state, root).read())
				.items.length,
			2,
		);
		fail = false;
		await vscode.commands.executeCommand("worky.retryCitation");
		assert.deepEqual(
			calls[1]!.request,
			calls[0]!.request,
			"retry preserves one batch message and destination",
		);
		assert.equal(controller.getCitations().length, 0);
		assert.equal((await store.read()).items.length, 0);
		// An editor from the sent batch still has a backing snapshot, even after
		// acknowledgement. Saving later changes queues only that edited draft.
		await vscode.window.showTextDocument(
			await vscode.workspace.openTextDocument(draftEditor.document.uri),
		);
		const sentEditor = vscode.window.activeTextEditor!;
		assert.ok(
			await sentEditor.edit((edit) =>
				edit.insert(new vscode.Position(0, 0), "Late edit\n"),
			),
		);
		assert.ok(await sentEditor.document.save());
		assert.equal((await store.read()).items.length, 1);
		assert.ok(
			(await store.read()).items[0]!.markdown.startsWith("Late edit\n"),
		);
		await store.clear(await store.read());
		await vscode.commands.executeCommand(
			"workbench.action.closeActiveEditor",
		);
		editor = await vscode.window.showTextDocument(document);
		prompt.askComment = async () => "remove me";
		await vscode.commands.executeCommand("worky.cite", document.uri);
		await vscode.commands.executeCommand(
			"worky.removeCitation",
			controller.getCitations()[0],
		);
		assert.equal((await store.read()).items.length, 0);
		editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(0, 0, 0, 0);
		await assert.rejects(controller.cite(), /Select code to cite/);
		assert.equal(calls.length, 2, "only send and retry contact T3");
		const aliasDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), "worky-citation-alias-"),
		);
		try {
			const alias = path.join(aliasDirectory, "workspace");
			await fs.symlink(root, alias);
			const aliasDocument = await vscode.workspace.openTextDocument(
				path.join(alias, path.basename(filename)),
			);
			const aliasEditor =
				await vscode.window.showTextDocument(aliasDocument);
			aliasEditor.selection = new vscode.Selection(0, 0, 1, 0);
			prompt.askComment = async () => "directory alias";
			await controller.cite();
			assert.equal(
				(await store.read()).items[0]!.citation.file,
				"citation-fixture.ts",
			);
			await store.clear(await store.read());
			await vscode.commands.executeCommand(
				"workbench.action.closeActiveEditor",
			);
		} finally {
			await fs.rm(aliasDirectory, { recursive: true, force: true });
		}
		// Real built-in Git documents: history, staged content, and working content.
		const historical = path.join(
			root,
			"removed-citation-directory",
			"historical.ts",
		);
		await fs.mkdir(path.dirname(historical));
		await fs.writeFile(historical, "const oldValue = 1;\n");
		await git(root, ["add", "--", historical]);
		await git(root, ["commit", "-m", "citation history fixture"]);
		const commit = (await git(root, ["rev-parse", "HEAD"])).trim();
		await fs.writeFile(historical, "const stagedValue = 2;\n");
		await git(root, ["add", "--", historical]);
		await fs.writeFile(historical, "const workingValue = 3;\n");
		const gitExtension = vscode.extensions.getExtension("vscode.git")!;
		const api = (await gitExtension.activate()).getAPI(1);
		await api.openRepository(vscode.Uri.file(root));
		prompt.askComment = async () => "diff citation";
		const base = vscode.Uri.file(historical);
		const indexUri = base.with({
			scheme: "git",
			query: JSON.stringify({ path: historical, ref: "" }),
		});
		const headUri = base.with({
			scheme: "git",
			query: JSON.stringify({ path: historical, ref: "HEAD" }),
		});
		await vscode.commands.executeCommand(
			"vscode.diff",
			headUri,
			indexUri,
			"Staged citation test",
		);
		for (const [uri, code, source] of [
			[headUri, "const oldValue = 1;\n", "Git revision HEAD"],
			[indexUri, "const stagedValue = 2;\n", "Git index (staged)"],
			[base, "const workingValue = 3;\n", undefined],
		] as const) {
			const selected = await vscode.window.showTextDocument(
				await vscode.workspace.openTextDocument(uri),
			);
			selected.selection = new vscode.Selection(0, 0, 1, 0);
			await vscode.commands.executeCommand("worky.cite", uri);
			const saved = (await store.read()).items.at(-1)!;
			assert.equal(saved.citation.code, code);
			assert.equal(saved.citation.source, source);
		}
		await fs.rm(path.dirname(historical), { recursive: true });
		const historyUri = base.with({
			scheme: "git",
			query: JSON.stringify({ path: historical, ref: commit }),
		});
		const historicalEditor = await vscode.window.showTextDocument(
			await vscode.workspace.openTextDocument(historyUri),
		);
		historicalEditor.selection = new vscode.Selection(0, 0, 1, 0);
		await vscode.commands.executeCommand("worky.cite", historyUri);
		assert.equal(
			(await store.read()).items.length,
			4,
			"both diff sides and deleted historical paths are collected",
		);
		assert.equal(
			(await store.read()).items.at(-1)!.citation.code,
			"const oldValue = 1;\n",
		);
		assert.ok((await store.read()).items.at(-1)!.markdown.includes(commit));
		await git(root, ["reset", "--", historical]);
		await git(root, ["checkout", "--", historical]);

		console.log(
			"Worky citation batch integration passed: offline collection, exact unsaved fenced snapshots, sidebar preview/edit/remove, cancellation, one-message send, durable retry, and acknowledgement cleanup.",
		);
	} finally {
		files.confirmRestoredDraft = originalRestoreConfirmation;
		prompt.askComment = originalPrompt;
		prompt.askInstruction = originalInstruction;
		prompt.pickThread = originalPicker;
		internal.t3Client = originalClient;
		await store.clear(await store.read());
		await controller.refresh();
		editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand("workbench.action.files.revert");
		await vscode.commands.executeCommand(
			"workbench.action.closeActiveEditor",
		);
		await fs.rm(filename, { force: true });
	}
}
