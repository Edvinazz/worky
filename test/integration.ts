import * as vscode from "vscode";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Worky } from "../src/extension";
import { SetupManager, TerminalTasks } from "../src/setup";
import { testActions } from "./actions-integration";
import { testPullRequestSetting } from "./pull-requests-integration";
import { testWorkspaceActions } from "./workspace-actions-integration";
import { testCurrentPullRequest } from "./current-pull-request-integration";
import { CitationStore } from "../src/citation-store";
import { testCitations } from "./citations-integration";
import { testDuplicate } from "./duplicate-integration";

async function waitFor(
	check: () => Promise<boolean>,
	description: string,
	timeout = 30_000,
): Promise<void> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out: ${description}`);
}

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

async function checkPrompt(
	terminal: vscode.Terminal,
	cwd: string,
	output: string,
): Promise<void> {
	assert.equal(
		terminal.exitStatus,
		undefined,
		"terminal shell remains alive",
	);
	terminal.sendText(`pwd > ${quote(output)}`);
	await waitFor(
		async () =>
			(await fs.readFile(output, "utf8").catch(() => "")).trim() === cwd,
		"terminal accepts a command after setup",
	);
}

export async function run(): Promise<void> {
	const f = JSON.parse(
		await fs.readFile(process.env.WORKY_TEST_FIXTURE!, "utf8"),
	) as {
		root: string;
		repository: string;
		worktree: string;
		events: string;
		shell: string;
	};
	const phase = process.env.WORKY_TEST_PHASE;
	try {
		const extension =
			vscode.extensions.getExtension<Worky>("Luksys3.worky");
		assert.ok(extension, "extension is installed in the development host");
		const worky = await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		for (const name of [
			"worky.duplicate",
			"worky.cite",
			"worky.retryCitation",
			"worky.openInT3",
			"worky.openCurrentInT3",
			"worky.newT3Thread",
			"worky.newCurrentT3Thread",
			"worky.openCurrentPullRequestOnGitHub",
		]) {
			assert.ok(commands.includes(name), `${name} is available`);
		}
		assert.ok(worky.repository, "repository initialized");
		const state = worky.repository.state;
		await waitFor(
			async () =>
				(await state.read(f.worktree))?.setup.status === "ready",
			"parallel terminal setup",
		);
		await worky.refreshWorktrees();
		assert.equal(worky.worktreeView.currentPath, f.worktree);
		assert.equal(worky.worktreeView.items.length, 2);
		assert.equal(
			(await state.read(f.worktree))?.setup.tasks.web!.exitCode,
			0,
		);
		assert.equal(
			(await state.read(f.worktree))?.setup.tasks.api!.exitCode,
			0,
		);
		const calls = async (app: string) =>
			(await fs.readFile(path.join(f.events, `${app}.calls`), "utf8"))
				.trim()
				.split("\n");
		if (phase === "first") {
			// A command unrelated to the original apps, at the repository root, using
			// the actual VS Code terminal profile. Quotes and comments must survive.
			const profileTasks = new TerminalTasks(undefined, state.directory);
			try {
				const output = path.join(f.events, "custom 'command'.txt");
				const result = await profileTasks.start(
					vscode.workspace.workspaceFolders![0]!,
					f.worktree,
					{
						name: "Tooling & docs",
						cwd: ".",
						command: `printf '%s' 'generic command' > ${quote(output)} # trailing comment`,
					},
					randomUUID(),
				);
				assert.equal(result.exitCode, 0);
				assert.equal(
					await fs.readFile(output, "utf8"),
					"generic command",
				);
				const terminal = vscode.window.terminals.find(
					(item) => item.name === "Tooling & docs",
				)!;
				assert.equal(
					(terminal.creationOptions as vscode.TerminalOptions)
						.shellPath,
					undefined,
				);
				await checkPrompt(
					terminal,
					f.worktree,
					path.join(f.events, "custom.prompt"),
				);
			} finally {
				profileTasks.dispose();
			}
			assert.deepEqual(await calls("web"), [
				path.join(f.worktree, "apps/web"),
			]);
			assert.deepEqual(await calls("api"), [
				path.join(f.worktree, "apps/api"),
			]);
			for (const app of ["web", "api"]) {
				const terminal = vscode.window.terminals.find(
					(terminal) =>
						(terminal.creationOptions as vscode.TerminalOptions).env
							?.WORKY_SETUP_APP === app,
				);
				assert.ok(terminal);
				await checkPrompt(
					terminal,
					path.join(f.worktree, "apps", app),
					path.join(f.events, `${app}.prompt`),
				);
			}

			// Retry must not rerun an app that already succeeded.
			const failed = (await state.read(f.worktree))!;
			failed.setup.status = "failed";
			failed.setup.tasks.web = {
				...failed.setup.tasks.web!,
				status: "failed",
				exitCode: 1,
			};
			await state.save(failed);
			const tasks = new TerminalTasks(f.shell, state.directory);
			try {
				const manager = new SetupManager(
					state,
					tasks,
					() => {},
					() => {},
					{ show() {} },
				);
				await fs.writeFile(path.join(f.events, "web.fail"), "");
				await manager.retry(f.worktree);
				await manager.resume(
					vscode.workspace.workspaceFolders![0]!,
					f.worktree,
				);
				assert.equal(
					(await state.read(f.worktree))?.setup.tasks.web!.exitCode,
					17,
				);
				assert.equal(
					(await state.read(f.worktree))?.setup.status,
					"failed",
				);
				const failedTerminal = vscode.window.terminals
					.filter((terminal) => terminal.name === "web")
					.at(-1)!;
				await checkPrompt(
					failedTerminal,
					path.join(f.worktree, "apps/web"),
					path.join(f.events, "failed.prompt"),
				);
				await fs.unlink(path.join(f.events, "web.fail"));
				await manager.retry(f.worktree);
				await manager.resume(
					vscode.workspace.workspaceFolders![0]!,
					f.worktree,
				);
				assert.equal(
					(await state.read(f.worktree))?.setup.status,
					"ready",
				);

				// Completion survives a lost observer, even if the terminal was already closed.
				const recovered = (await state.read(f.worktree))!;
				const runId = recovered.setup.runId!;
				for (const terminal of vscode.window.terminals) {
					if (
						(terminal.creationOptions as vscode.TerminalOptions).env
							?.WORKY_SETUP_RUN_ID === runId
					)
						terminal.dispose();
				}
				recovered.setup.status = "running";
				recovered.setup.tasks.web = {
					...recovered.setup.tasks.web!,
					status: "running",
				};
				await state.save(recovered);
				await manager.resume(
					vscode.workspace.workspaceFolders![0]!,
					f.worktree,
				);
				assert.equal(
					(await state.read(f.worktree))?.setup.status,
					"ready",
				);

				// Ctrl+C cancels setup, records its failure, and returns to a usable prompt.
				await fs.writeFile(path.join(f.events, "web.hold"), "");
				const cancelledRun = randomUUID();
				const cancelled = tasks.start(
					vscode.workspace.workspaceFolders![0]!,
					f.worktree,
					failed.setup.tasks.web!,
					cancelledRun,
				);
				await waitFor(
					async () => (await calls("web")).length === 4,
					"setup before Ctrl+C",
				);
				const cancelledTerminal = await tasks.existing(
					f.worktree,
					"web",
					cancelledRun,
				);
				assert.ok(cancelledTerminal && !("task" in cancelledTerminal));
				cancelledTerminal.sendText("\u0003", false);
				assert.deepEqual(await cancelled, { exitCode: 130 });
				await checkPrompt(
					cancelledTerminal,
					path.join(f.worktree, "apps/web"),
					path.join(f.events, "cancelled.prompt"),
				);

				const closedRun = randomUUID();
				const closed = tasks.start(
					vscode.workspace.workspaceFolders![0]!,
					f.worktree,
					failed.setup.tasks.web!,
					closedRun,
				);
				await waitFor(
					async () => (await calls("web")).length === 5,
					"setup before closing terminal",
				);
				const closedTerminal = await tasks.existing(
					f.worktree,
					"web",
					closedRun,
				);
				assert.ok(closedTerminal && !("task" in closedTerminal));
				closedTerminal.dispose();
				assert.ok(
					(await closed).error,
					"closing an unfinished setup reports interruption",
				);
				await fs.unlink(path.join(f.events, "web.hold"));
			} finally {
				tasks.dispose();
			}
			assert.equal((await calls("web")).length, 5);
			assert.equal((await calls("api")).length, 1);
			await testActions(worky);
			await testPullRequestSetting(worky);
			await testWorkspaceActions(worky);
			await testCurrentPullRequest(worky);
			await testDuplicate(worky);
			await testCitations(worky);
			await new CitationStore(state, f.worktree).add(
				{
					file: "reload.ts",
					startLine: 1,
					startColumn: 1,
					endLine: 1,
					endColumn: 12,
					language: "typescript",
					code: "const x = 1",
					unsaved: true,
				},
				"Survives reload",
			);
		} else {
			const citations = new CitationStore(state, f.worktree);
			const batch = await citations.read();
			assert.equal(
				batch.items.length,
				1,
				"citation survives an actual VS Code restart",
			);
			assert.ok(
				batch.items[0]!.markdown.includes(
					"```typescript\nconst x = 1\n```",
				),
			);
			await citations.clear(batch);
			// A fresh extension host opening an already prepared worktree must do nothing.
			await new Promise((resolve) => setTimeout(resolve, 1500));
			assert.equal((await calls("web")).length, 5);
			assert.equal((await calls("api")).length, 1);
			assert.equal(
				vscode.tasks.taskExecutions.filter(
					(task) => task.task.definition.type === "worky",
				).length,
				0,
			);
		}
		await fs.writeFile(path.join(f.root, `${phase}.passed`), "passed");
		console.log(
			`Worky integration (${phase}) passed: parallel setup, interactive prompts, failures, retry, cancellation, recovery, and no automatic rerun.`,
		);
	} catch (error) {
		await fs.writeFile(path.join(f.root, `${phase}.failed`), String(error));
		throw error;
	}
}
