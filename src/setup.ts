import * as vscode from "vscode";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { AppSetup, message, setupStatus } from "./model";
import { commandDirectory, readConfig, SetupCommand } from "./config";
import { BusyError, StateStore } from "./state";

export interface TaskResult {
	exitCode?: number;
	error?: string;
}

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function isWorkyTask(
	task: vscode.Task,
	worktreePath: string,
	app?: string,
	runId?: string,
): boolean {
	const definition = task.definition;
	return (
		definition.type === "worky" &&
		definition.worktree === worktreePath &&
		(!app || definition.app === app) &&
		(!runId || definition.runId === runId)
	);
}

export class TerminalTasks {
	private listeners = new Set<vscode.Disposable>();

	constructor(
		private readonly shellPath: string | undefined,
		private readonly stateDirectory: string,
	) {}

	private resultPath(
		worktreePath: string,
		app: string,
		runId: string,
	): string {
		const key = createHash("sha256")
			.update(JSON.stringify([worktreePath, app, runId]))
			.digest("hex");
		return path.join(this.stateDirectory, "setup-results", `${key}.exit`);
	}

	async result(
		worktreePath: string,
		app: string,
		runId: string,
	): Promise<TaskResult | undefined> {
		try {
			const value = (
				await fs.readFile(
					this.resultPath(worktreePath, app, runId),
					"utf8",
				)
			).trim();
			const exitCode = Number(value);
			return /^\d+$/.test(value) &&
				Number.isInteger(exitCode) &&
				exitCode <= 255
				? { exitCode }
				: { error: "Setup returned an invalid exit status." };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return undefined;
			throw error;
		}
	}

	async existing(
		worktreePath: string,
		app: string,
		runId?: string,
	): Promise<vscode.Terminal | vscode.TaskExecution | undefined> {
		for (const terminal of vscode.window.terminals) {
			const env = (terminal.creationOptions as vscode.TerminalOptions)
				.env;
			if (
				terminal.exitStatus ||
				env?.WORKY_SETUP_WORKTREE !== worktreePath ||
				env.WORKY_SETUP_APP !== app ||
				!env.WORKY_SETUP_RUN_ID ||
				(runId && env.WORKY_SETUP_RUN_ID !== runId)
			)
				continue;
			// A completed setup terminal remains available as an ordinary shell, not an active setup.
			if (!(await this.result(worktreePath, app, env.WORKY_SETUP_RUN_ID)))
				return terminal;
		}
		// Keep observing setups started by older Worky versions during an extension update.
		return vscode.tasks.taskExecutions.find((execution) =>
			isWorkyTask(execution.task, worktreePath, app, runId),
		);
	}

	async start(
		_folder: vscode.WorkspaceFolder,
		worktreePath: string,
		task: SetupCommand,
		runId: string,
	): Promise<TaskResult> {
		const app = task.name;
		try {
			const resultPath = this.resultPath(worktreePath, app, runId);
			await fs.mkdir(path.dirname(resultPath), { recursive: true });
			const terminal = vscode.window.createTerminal({
				name: task.name,
				cwd: await commandDirectory(worktreePath, task.cwd),
				...(this.shellPath
					? { shellPath: this.shellPath, shellArgs: ["-i"] }
					: {}),
				env: {
					WORKY_SETUP_WORKTREE: worktreePath,
					WORKY_SETUP_APP: app,
					WORKY_SETUP_RUN_ID: runId,
				},
			});
			const result = this.observeTerminal(
				terminal,
				worktreePath,
				app,
				runId,
			);
			// Track the command's exit separately from the interactive shell's lifetime. The
			// subshell confines traps to setup and also records Ctrl+C without closing the prompt.
			const record = `worky_setup_exit=$?; printf '%s\\n' "$worky_setup_exit" > ${quote(resultPath + ".tmp")} && mv ${quote(resultPath + ".tmp")} ${quote(resultPath)}; printf '\\n[Worky] Setup finished (exit %s).\\n' "$worky_setup_exit"`;
			// Use a file rather than typing multiline shell source into the prompt.
			// The inner subshell also keeps a command's exec/traps from replacing ours.
			const scriptPath = resultPath + ".sh";
			await fs.writeFile(
				scriptPath,
				`trap ${quote(record)} EXIT\ntrap 'exit 130' INT\n(\n${task.command}\n)\n`,
				{ mode: 0o600 },
			);
			if (this.shellPath) terminal.sendText(`bash ${quote(scriptPath)}`);
			else {
				// The terminal uses the user's VS Code profile. A Bash child executes
				// repository commands and writes a receipt even across extension reloads.
				const integration = await this.shellIntegration(terminal);
				if (integration)
					integration.executeCommand("bash", [scriptPath]);
				else if (process.platform !== "win32")
					terminal.sendText(`bash ${quote(scriptPath)}`);
				else {
					terminal.dispose();
					return {
						error: "Enable VS Code terminal shell integration and install Bash for setup commands.",
					};
				}
			}
			terminal.show(true);
			return result;
		} catch (error) {
			return { error: message(error) };
		}
	}

	private async shellIntegration(
		terminal: vscode.Terminal,
	): Promise<vscode.TerminalShellIntegration | undefined> {
		if (terminal.shellIntegration) return terminal.shellIntegration;
		return new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				listener.dispose();
				resolve(terminal.shellIntegration);
			};
			const listener = vscode.window.onDidChangeTerminalShellIntegration(
				(event) => {
					if (event.terminal === terminal) finish();
				},
			);
			const timer = setTimeout(finish, 2000);
		});
	}

	async reconnect(
		execution: vscode.Terminal | vscode.TaskExecution,
		worktreePath: string,
		app: string,
		runId: string,
	): Promise<TaskResult> {
		return "task" in execution
			? this.observe(execution.task, async () => execution)
			: this.observeTerminal(execution, worktreePath, app, runId);
	}

	private observeTerminal(
		terminal: vscode.Terminal,
		worktreePath: string,
		app: string,
		runId: string,
	): Promise<TaskResult> {
		return new Promise((resolve) => {
			let settled = false;
			let closed = terminal.exitStatus !== undefined;
			let timer: NodeJS.Timeout | undefined;
			const subscription = vscode.Disposable.from(
				vscode.window.onDidCloseTerminal((candidate) => {
					if (candidate === terminal) closed = true;
				}),
				{
					dispose: () => {
						settled = true;
						if (timer) clearTimeout(timer);
					},
				},
			);
			const finish = (result: TaskResult) => {
				subscription.dispose();
				this.listeners.delete(subscription);
				resolve(result);
			};
			const check = async () => {
				try {
					const result = await this.result(worktreePath, app, runId);
					if (settled) return;
					if (result) finish(result);
					else if (closed)
						finish({
							error: "Setup terminal closed before setup finished.",
						});
					else
						timer = setTimeout(() => {
							void check();
						}, 250);
				} catch (error) {
					if (!settled) finish({ error: message(error) });
				}
			};
			this.listeners.add(subscription);
			void check();
		});
	}

	private observe(
		task: vscode.Task,
		start: () => PromiseLike<vscode.TaskExecution>,
	): Promise<TaskResult> {
		return new Promise((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const match = (candidate: vscode.Task) =>
				isWorkyTask(
					candidate,
					task.definition.worktree,
					task.definition.app,
					task.definition.runId,
				);
			const finish = (result: TaskResult) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				subscription.dispose();
				this.listeners.delete(subscription);
				resolve(result);
			};
			const processListener = vscode.tasks.onDidEndTaskProcess(
				(event) => {
					if (match(event.execution.task))
						finish({ exitCode: event.exitCode });
				},
			);
			const endListener = vscode.tasks.onDidEndTask((event) => {
				// Cancellation or failure to spawn may have no process exit event.
				if (match(event.execution.task))
					timer = setTimeout(
						() =>
							finish({
								error: "Setup stopped without an exit code.",
							}),
						250,
					);
			});
			const subscription = vscode.Disposable.from(
				processListener,
				endListener,
			);
			this.listeners.add(subscription);
			Promise.resolve(start()).catch((error) =>
				finish({ error: message(error) }),
			);
		});
	}

	dispose(): void {
		this.listeners.forEach((listener) => listener.dispose());
		this.listeners.clear();
	}
}

export class SetupManager {
	private inFlight = new Map<string, Promise<void>>();

	constructor(
		private readonly store: StateStore,
		private readonly tasks: TerminalTasks,
		private readonly changed: () => void,
		private readonly log: (line: string) => void,
	) {}

	resume(
		folder: vscode.WorkspaceFolder,
		worktreePath: string,
	): Promise<void> {
		const active = this.inFlight.get(worktreePath);
		if (active) return active;
		const operation = this.run(folder, worktreePath).finally(() =>
			this.inFlight.delete(worktreePath),
		);
		this.inFlight.set(worktreePath, operation);
		return operation;
	}

	private async run(
		folder: vscode.WorkspaceFolder,
		worktreePath: string,
	): Promise<void> {
		const before = await this.store.read(worktreePath);
		if (
			!before ||
			!["pending", "running"].includes(before.setup.status) ||
			!vscode.workspace.isTrusted
		)
			return;
		try {
			await this.store.withLock(worktreePath, async () => {
				const state = await this.store.read(worktreePath);
				if (
					!state ||
					!["pending", "running"].includes(state.setup.status)
				)
					return;
				const reconnecting = state.setup.status === "running";
				const runId = state.setup.runId ?? randomUUID();
				state.setup.runId = runId;
				const targetApps = Object.keys(state.setup.tasks).filter(
					(app) =>
						reconnecting
							? ["running", "pending"].includes(
									state.setup.tasks[app]!.status,
								)
							: state.setup.tasks[app]!.status !== "ready",
				);
				state.setup.status = "running";
				const persist = async () => {
					state.setup.updatedAt = new Date().toISOString();
					await this.store.save(state);
					this.changed();
				};
				// Persist all running states before launching either task.
				targetApps.forEach((app) => {
					state.setup.tasks[app] = {
						...state.setup.tasks[app]!,
						status: "running",
						error: undefined,
						exitCode: undefined,
					};
				});
				await persist();
				await Promise.all(
					targetApps.map(async (app) => {
						const completed = await this.tasks.result(
							worktreePath,
							app,
							runId,
						);
						const execution = await this.tasks.existing(
							worktreePath,
							app,
							runId,
						);
						let result: TaskResult;
						if (completed) result = completed;
						else if (execution)
							result = await this.tasks.reconnect(
								execution,
								worktreePath,
								app,
								runId,
							);
						else if (reconnecting)
							result = {
								error: "Setup was interrupted. Use Retry Failed Setup to run it again.",
							};
						else
							result = await this.tasks.start(
								folder,
								worktreePath,
								state.setup.tasks[app]!,
								runId,
							);
						const appState: AppSetup =
							result.exitCode === 0
								? {
										...state.setup.tasks[app]!,
										status: "ready",
										exitCode: 0,
									}
								: {
										...state.setup.tasks[app]!,
										status:
											result.exitCode === undefined
												? "interrupted"
												: "failed",
										...result,
									};
						state.setup.tasks[app] = appState;
						state.setup.status = setupStatus(state.setup.tasks);
						this.log(
							`${app} setup in ${worktreePath}: ${appState.status}${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""}`,
						);
						await persist();
					}),
				);
				state.setup.status = setupStatus(state.setup.tasks);
				await persist();
				if (state.setup.status === "ready") {
					void vscode.window.showInformationMessage(
						"Worky: setup finished.",
					);
				} else {
					void vscode.window.showWarningMessage(
						"Worky: setup did not finish successfully. Check the setup terminals; Retry Failed Setup reruns only unfinished commands.",
					);
				}
			});
		} catch (error) {
			if (error instanceof BusyError) return;
			throw error;
		}
	}

	async retry(worktreePath: string): Promise<void> {
		await this.store.withLock(worktreePath, async () => {
			const state = await this.store.read(worktreePath);
			if (
				!state ||
				!["failed", "interrupted"].includes(state.setup.status)
			)
				throw new Error("There is no failed setup to retry.");
			if (
				(
					await Promise.all(
						Object.keys(state.setup.tasks).map((app) =>
							this.tasks.existing(worktreePath, app),
						),
					)
				).some(Boolean)
			) {
				throw new Error("Setup is still running in this window.");
			}
			if (
				state.setup.error ||
				(await fs.stat(path.join(worktreePath, "worky.json")).then(
					() => true,
					() => false,
				))
			) {
				const config = await readConfig(worktreePath);
				state.setup.tasks = Object.fromEntries(
					config.setup.map((task) => [
						task.name,
						state.setup.tasks[task.name]?.status === "ready"
							? state.setup.tasks[task.name]!
							: { ...task, status: "pending" },
					]),
				);
				delete state.setup.error;
			}
			state.setup.status = Object.keys(state.setup.tasks).length
				? "pending"
				: "skipped";
			state.setup.runId = undefined;
			for (const task of Object.values(state.setup.tasks))
				if (task.status !== "ready") {
					task.status = "pending";
					task.error = undefined;
					task.exitCode = undefined;
				}
			state.setup.updatedAt = new Date().toISOString();
			await this.store.save(state);
		});
		this.changed();
	}
}
