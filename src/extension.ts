import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git, matchesPullRequest, parseWorktrees, Worktrees } from "./git";
import { readConfig } from "./config";
import { canonicalPath, isWithinDirectory } from "./paths";
import { GitHubClient } from "./github";
import { message, PullRequest, Worktree } from "./model";
import { SetupManager, TerminalTasks } from "./setup";
import { runTeardown, TeardownError } from "./teardown";
import { T3Client } from "./t3";
import { Citations, CitationDestination, CitationRow } from "./citations";
import { Notifications } from "./notifications";
import { CitationStore } from "./citation-store";
import { GoToItem, goToItems } from "./go-to";
import {
	pullRequestKey,
	PullRequestItem,
	PullRequestsView,
	WorktreeItem,
	WorktreesView,
} from "./views";

function expandHome(value: string): string {
	return value === "~"
		? os.homedir()
		: value.startsWith("~/")
			? path.join(os.homedir(), value.slice(2))
			: path.resolve(value);
}

export class Worky implements vscode.Disposable {
	readonly worktreeView = new WorktreesView();
	readonly pullRequestView = new PullRequestsView(this.worktreeView.activity);
	repository?: Worktrees;
	private setup?: SetupManager;
	private configKey?: string;
	private refreshing?: Promise<void>;
	private refreshingPulls?: Promise<void>;
	private pullRequestAbort?: AbortController;
	private pullRequestsEnabled = false;
	private lastPullRefresh = 0;
	private refreshTimer?: NodeJS.Timeout;
	private creating = false;
	private t3?: { key: string; client: T3Client };
	private readonly citations: Citations;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly log = vscode.window.createOutputChannel("Worky");
	private readonly notifications = new Notifications((line) =>
		this.log.appendLine(line),
	);
	private readonly trees: vscode.TreeView<WorktreeItem | vscode.TreeItem>[] =
		[];

	constructor() {
		const worktrees = vscode.window.createTreeView("worky.worktrees", {
			treeDataProvider: this.worktreeView,
		});
		const pulls = vscode.window.createTreeView("worky.pullRequests", {
			treeDataProvider: this.pullRequestView,
		});
		this.trees.push(
			worktrees,
			pulls as vscode.TreeView<WorktreeItem | vscode.TreeItem>,
		);
		this.disposables.push(
			worktrees,
			pulls,
			this.worktreeView,
			this.pullRequestView,
			this.log,
			this.notifications,
		);
		const command = (name: string, action: (...args: any[]) => unknown) => {
			this.disposables.push(
				vscode.commands.registerCommand(
					`worky.${name}`,
					async (...args) => {
						try {
							return await action(...args);
						} catch (error) {
							this.report(error);
						}
					},
				),
			);
		};
		const citations = (this.citations = new Citations(
			async (file) => {
				const repository = this.requireRepository();
				// Historical files (including their directories) may no longer exist.
				let directory = path.dirname(file);
				while (
					!(
						await fs.stat(directory).catch(() => undefined)
					)?.isDirectory()
				) {
					const parent = path.dirname(directory);
					if (parent === directory)
						throw new Error("Cannot locate the source repository.");
					directory = parent;
				}
				const root = (
					await git(directory, ["rev-parse", "--show-toplevel"])
				).trim();
				const worktree = (await repository.list(false)).find(
					(item) => item.path === root,
				);
				if (!worktree || worktree.bare || worktree.prunable)
					throw new Error(
						"The selected file must belong to a worktree of this window's repository.",
					);
				return this.citationDestination(worktree);
			},
			() => {
				const worktree = this.worktreeView.items.find(
					(item) => item.path === this.worktreeView.currentPath,
				);
				return this.repository && worktree
					? this.citationDestination(worktree)
					: undefined;
			},
			this.notifications,
		));
		this.disposables.push(citations);
		command("cite", (uri?: vscode.Uri) => citations.cite(uri));
		command("retryCitation", () => citations.send(true));
		command("sendCitations", () => citations.send());
		command("selectCitationThread", () => citations.selectThread());
		command("clearCitations", () => citations.clear());
		command("previewCitation", (row: CitationRow) =>
			citations.preview(row),
		);
		command("editCitation", (row: CitationRow) => citations.edit(row));
		command("removeCitation", (row: CitationRow) => citations.remove(row));
		command("refresh", () => this.refresh(true));
		command("create", () => this.create());
		command("duplicate", (item?: WorktreeItem) =>
			this.duplicate(item?.worktree),
		);
		command("open", (item: WorktreeItem) => this.open(item.worktree));
		command("openNewWindow", (item: WorktreeItem) =>
			this.open(item.worktree, true),
		);
		command("openCurrentWindow", (item: WorktreeItem) =>
			this.open(item.worktree, false),
		);
		command("openInT3", (item: WorktreeItem) =>
			this.openInT3(item.worktree),
		);
		command("newT3Thread", (item: WorktreeItem) =>
			this.openInT3(item.worktree, true),
		);
		command("openCurrentInT3", () => this.openCurrentInT3());
		command("newCurrentT3Thread", () => this.openCurrentInT3(true));
		command("openCurrentPullRequestOnGitHub", () =>
			this.openCurrentPullRequestOnGitHub(),
		);
		command("currentWorktreeBusy", () => {});
		command("remove", (item: WorktreeItem) => this.remove(item.worktree));
		command("retrySetup", (item: WorktreeItem) =>
			this.retry(item.worktree),
		);
		command("openPullRequest", (item: PullRequestItem) => {
			if (this.pullRequestsEnabled)
				return this.openPullRequest(item.pullRequest);
		});
		command("openPullRequestNewWindow", (item: PullRequestItem) => {
			if (this.pullRequestsEnabled)
				return this.openPullRequest(item.pullRequest, true);
		});
		command("openPullRequestCurrentWindow", (item: PullRequestItem) => {
			if (this.pullRequestsEnabled)
				return this.openPullRequest(item.pullRequest, false);
		});
		command("goTo", () => this.goTo());
		command("openPullRequestOnGitHub", (item: PullRequestItem) => {
			if (this.pullRequestsEnabled)
				return this.openPullRequestOnGitHub(item.pullRequest);
		});
		command("signIn", async () => {
			if (!this.pullRequestsEnabled) return;
			await vscode.authentication.getSession("github", ["repo"], {
				createIfNone: true,
			});
			await this.refresh(true);
		});
		command("settings", () =>
			vscode.commands.executeCommand(
				"workbench.action.openSettings",
				"@ext:Luksys3.worky",
			),
		);
		command("showLog", () => this.log.show());
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				void this.refresh(true).catch((error) => this.report(error));
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("worky"))
					void this.refresh(true).catch((error) =>
						this.report(error),
					);
			}),
			vscode.window.onDidChangeWindowState((event) => {
				if (event.focused)
					void this.refresh().catch((error) => this.report(error));
			}),
			vscode.authentication.onDidChangeSessions((event) => {
				if (event.provider.id === "github") {
					this.pullRequestView.items = [];
					this.updateCurrentWorktreeContext();
					void this.refreshPullRequests(true).catch((error) =>
						this.report(error),
					);
				}
			}),
			pulls.onDidChangeVisibility((event) => {
				if (event.visible)
					void this.refreshPullRequests().catch((error) =>
						this.report(error),
					);
			}),
		);
		const watcher =
			vscode.workspace.createFileSystemWatcher("**/worky.json");
		const reload = () => {
			void this.refresh(true).catch((error) => this.report(error));
		};
		this.disposables.push(
			watcher,
			watcher.onDidChange(reload),
			watcher.onDidCreate(reload),
			watcher.onDidDelete(reload),
		);
		const timer = setInterval(() => {
			if (
				vscode.window.state.focused &&
				this.trees.some((tree) => tree.visible)
			) {
				void this.refresh().catch((error) =>
					this.log.appendLine(message(error)),
				);
			}
		}, 30_000);
		this.disposables.push({ dispose: () => clearInterval(timer) });
	}

	private report(error: unknown): void {
		this.notifications.show(`Worky: ${message(error)}`, "error");
	}

	private changed = (): void => {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			void this.refreshWorktrees().catch((error) => this.report(error));
		}, 150);
	};

	async refresh(forcePulls = false): Promise<void> {
		await this.refreshWorktrees(forcePulls);
		await this.refreshPullRequests(forcePulls);
	}

	async refreshWorktrees(afterMutation = false): Promise<void> {
		if (this.refreshing) {
			await this.refreshing;
			if (!afterMutation) return;
			// A refresh already in flight may contain worktrees removed since it started.
			return this.refreshWorktrees();
		}
		this.refreshing = Promise.resolve(
			vscode.window.withProgress(
				{ location: { viewId: "worky.worktrees" } },
				() => this.loadWorktrees(),
			),
		).finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	private async loadWorktrees(): Promise<void> {
		try {
			const config = vscode.workspace.getConfiguration("worky");
			const override = config.get<string>("repositoryPath");
			const source = override
				? expandHome(override)
				: this.currentFolder()?.uri.fsPath;
			if (!source)
				throw new Error(
					"Open a Git repository or set worky.repositoryPath.",
				);
			const repositoryPath = (
				await git(source, ["rev-parse", "--show-toplevel"])
			).trim();
			const project = await readConfig(
				(await this.currentPath()) ?? repositoryPath,
			);
			await this.setPullRequestsEnabled(
				project.pullRequests?.enabled ?? true,
			);
			const mainPath =
				parseWorktrees(
					await git(repositoryPath, [
						"worktree",
						"list",
						"--porcelain",
						"-z",
					]),
				)[0]?.path ?? repositoryPath;
			const worktreesPath = config.get<string>("worktreesPath");
			const values = {
				repositoryPath,
				worktreesPath: worktreesPath
					? expandHome(worktreesPath)
					: path.join(
							os.homedir(),
							"worktrees",
							path.basename(mainPath),
						),
				baseBranch:
					config.get<string>("baseBranch") ||
					project.baseBranch ||
					"",
				remote: config.get<string>("remote") || project.remote || "",
			};
			const key = JSON.stringify({
				...values,
				shell: config.get<string>("shellPath"),
			});
			if (!this.repository || this.configKey !== key) {
				this.resetPullRequests();
				this.repository = await Worktrees.connect(values);
				this.configKey = key;
				this.lastPullRefresh = 0;
				this.pullRequestView.items = [];
				const tasks = new TerminalTasks(
					config.get<string>("shellPath") || undefined,
					this.repository.state.directory,
				);
				this.disposables.push(tasks);
				this.setup = new SetupManager(
					this.repository.state,
					tasks,
					this.changed,
					(line) => this.log.appendLine(line),
					this.notifications,
				);
			}
			this.worktreeView.items = await this.repository.list();
			this.worktreeView.baseBranch = this.repository.config.baseBranch;
			this.worktreeView.error = undefined;
			this.worktreeView.currentPath = await this.currentPath();
			this.pullRequestView.worktrees = this.worktreeView.items;
			const folder = this.currentFolder();
			if (folder && this.worktreeView.currentPath) {
				// Run only persisted, unfinished setup initiated by Worky. External worktrees have no marker.
				void this.setup
					?.resume(folder, this.worktreeView.currentPath)
					.catch((error) => this.report(error));
			}
		} catch (error) {
			await this.setPullRequestsEnabled(false);
			this.repository = undefined;
			this.worktreeView.error = message(error);
			this.worktreeView.items = [];
			this.worktreeView.currentPath = undefined;
			this.log.appendLine(`Repository: ${message(error)}`);
		}
		this.pullRequestView.currentPath = this.worktreeView.currentPath;
		this.worktreeView.refresh();
		this.pullRequestView.refresh();
		this.updateCurrentWorktreeContext();
		await this.citations.refresh();
	}

	private currentFolder(): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.[0];
	}

	private async currentPath(): Promise<string | undefined> {
		const folder = this.currentFolder();
		if (!folder) return undefined;
		try {
			return (
				await git(folder.uri.fsPath, ["rev-parse", "--show-toplevel"])
			).trim();
		} catch {
			return undefined;
		}
	}

	private requireRepository(): Worktrees {
		if (!this.repository)
			throw new Error(
				"Open a Git repository or configure its path in Worky settings.",
			);
		return this.repository;
	}

	private async setPullRequestsEnabled(enabled: boolean): Promise<void> {
		if (enabled !== this.pullRequestsEnabled) this.resetPullRequests();
		this.pullRequestsEnabled = enabled;
		await vscode.commands.executeCommand(
			"setContext",
			"worky.pullRequestsEnabled",
			enabled,
		);
	}

	private get openInNewWindow(): boolean {
		return vscode.workspace
			.getConfiguration("worky")
			.get<boolean>("openInNewWindow", false);
	}

	private updateCurrentWorktreeContext(): void {
		const current = this.worktreeView.items.find(
			(item) => item.path === this.worktreeView.currentPath,
		);
		void vscode.commands.executeCommand(
			"setContext",
			"worky.hasCurrentWorktree",
			Boolean(current),
		);
		void vscode.commands.executeCommand(
			"setContext",
			"worky.currentWorktreeBusy",
			Boolean(current && this.worktreeView.activity.has(current.path)),
		);
		this.worktreeView.currentPullRequest = this.currentPullRequest;
		this.worktreeView.refresh();
		void vscode.commands.executeCommand(
			"setContext",
			"worky.hasCurrentPullRequest",
			Boolean(this.worktreeView.currentPullRequest),
		);
	}

	private get currentPullRequest(): PullRequest | undefined {
		return this.pullRequestFor(
			this.worktreeView.items.find(
				(item) => item.path === this.worktreeView.currentPath,
			),
		);
	}

	private pullRequestFor(current?: Worktree): PullRequest | undefined {
		if (
			!this.pullRequestsEnabled ||
			!this.pullRequestView.signedIn ||
			this.pullRequestView.error
		)
			return undefined;
		return current
			? this.pullRequestView.items.find((pr) =>
					matchesPullRequest(current, pr),
				)
			: undefined;
	}

	private openPullRequestOnGitHub(pr: PullRequest): Thenable<boolean> {
		return vscode.env.openExternal(vscode.Uri.parse(pr.url));
	}

	private async openCurrentPullRequestOnGitHub(): Promise<void> {
		if (!this.pullRequestsEnabled) return;
		const current = this.worktreeView.items.find(
			(item) => item.path === this.worktreeView.currentPath,
		);
		if (!current) return;
		// PRs are already loaded in the background. Only check this checkout's
		// branch: listing/status-checking every worktree or fetching GitHub here
		// delays the browser, especially in repositories with many worktrees.
		const branch = await git(current.path, [
			"symbolic-ref",
			"--quiet",
			"--short",
			"HEAD",
		]).then(
			(value) => value.trim(),
			() => undefined,
		);
		if (!this.pullRequestsEnabled) return;
		if (branch !== current.branch) this.changed();
		const pr = branch
			? this.pullRequestFor({ ...current, branch })
			: undefined;
		if (pr) await this.openPullRequestOnGitHub(pr);
		else
			this.notifications.show(
				"Worky: no open pull request is available for the current worktree.",
			);
	}

	private resetPullRequests(): void {
		this.pullRequestAbort?.abort();
		this.pullRequestAbort = undefined;
		this.refreshingPulls = undefined;
		this.lastPullRefresh = 0;
		this.pullRequestView.items = [];
		this.pullRequestView.signedIn = false;
		this.pullRequestView.loading = false;
		this.pullRequestView.error = undefined;
		this.pullRequestView.reviewWarning = undefined;
		this.pullRequestView.refresh();
		this.updateCurrentWorktreeContext();
	}

	async refreshPullRequests(force = false): Promise<void> {
		if (!this.pullRequestsEnabled) return;
		if (this.refreshingPulls) return this.refreshingPulls;
		if (
			!this.repository ||
			(!force && Date.now() - this.lastPullRefresh < 120_000)
		)
			return;
		const controller = new AbortController();
		this.pullRequestAbort = controller;
		this.refreshingPulls = Promise.resolve(
			vscode.window.withProgress(
				{ location: { viewId: "worky.pullRequests" } },
				() => this.loadPullRequests(controller.signal),
			),
		).finally(() => {
			if (this.pullRequestAbort === controller) {
				this.refreshingPulls = undefined;
				this.pullRequestAbort = undefined;
			}
		});
		return this.refreshingPulls;
	}

	private async loadPullRequests(signal: AbortSignal): Promise<void> {
		if (signal.aborted || !this.pullRequestsEnabled) return;
		this.lastPullRefresh = Date.now();
		this.pullRequestView.loading = true;
		this.pullRequestView.refresh();
		try {
			const session = await vscode.authentication.getSession(
				"github",
				["repo"],
				{ silent: true },
			);
			if (signal.aborted) return;
			this.pullRequestView.signedIn = Boolean(session);
			if (!session) {
				this.pullRequestView.items = [];
				return;
			}
			const repository =
				await this.requireRepository().remoteRepository();
			if (signal.aborted) return;
			const result = await new GitHubClient(
				session.accessToken,
				fetch,
				signal,
			).list(repository);
			if (signal.aborted) return;
			this.pullRequestView.items = result.pullRequests;
			this.pullRequestView.reviewWarning = result.reviewWarning;
			this.pullRequestView.error = undefined;
		} catch (error) {
			if (signal.aborted) return;
			this.pullRequestView.error = message(error);
			this.log.appendLine(`Pull requests: ${message(error)}`);
		} finally {
			if (!signal.aborted) {
				this.pullRequestView.loading = false;
				this.pullRequestView.refresh();
				this.updateCurrentWorktreeContext();
			}
		}
	}

	private uriFor(worktreePath: string): vscode.Uri {
		const folder = this.currentFolder();
		return folder && folder.uri.scheme !== "file"
			? folder.uri.with({ path: worktreePath, query: "", fragment: "" })
			: vscode.Uri.file(worktreePath);
	}

	async open(
		worktree: Worktree,
		newWindow = this.openInNewWindow,
	): Promise<void> {
		return this.withWorktreeActivity(worktree, "Opening…", () =>
			this.openFolder(worktree, newWindow),
		);
	}

	private async withWorktreeActivity(
		worktree: Worktree,
		label: string,
		action: () => Promise<void>,
	): Promise<void> {
		if (this.worktreeView.activity.has(worktree.path)) return;
		this.worktreeView.activity.set(worktree.path, { worktree, label });
		this.worktreeView.refresh();
		this.pullRequestView.refresh();
		this.updateCurrentWorktreeContext();
		try {
			await action();
		} finally {
			this.worktreeView.activity.delete(worktree.path);
			this.worktreeView.refresh();
			this.pullRequestView.refresh();
			this.updateCurrentWorktreeContext();
		}
	}

	private async openFolder(
		worktree: Worktree,
		newWindow = false,
	): Promise<void> {
		if (worktree.prunable)
			throw new Error(
				`The worktree directory is missing: ${worktree.path}`,
			);
		if (worktree.path === (await this.currentPath())) {
			const folder = this.currentFolder();
			if (folder)
				void this.setup
					?.resume(folder, worktree.path)
					.catch((error) => this.report(error));
			if (!newWindow) return;
		}
		// Opening in the current window shuts down this extension host. All setup state
		// must already be persisted; the destination window resumes it on activation.
		await vscode.commands.executeCommand(
			"vscode.openFolder",
			this.uriFor(worktree.path),
			newWindow ? { forceNewWindow: true } : { forceReuseWindow: true },
		);
	}

	private async create(branch?: string): Promise<void> {
		if (this.creating) return;
		this.creating = true;
		try {
			await this.createWorktree(branch);
		} finally {
			this.creating = false;
			this.worktreeView.creating = undefined;
			this.worktreeView.refresh();
		}
	}

	private async createWorktree(value?: string): Promise<void> {
		const repository = this.requireRepository();
		const branch = await vscode.window.showInputBox({
			title: "Create New Worktree",
			value,
			prompt: `Branch name — new branches start from ${[repository.config.remote, repository.config.baseBranch].filter(Boolean).join("/")}`,
			placeHolder: "feature/my-change",
			ignoreFocusOut: true,
			validateInput: async (value) => {
				if (!value) return undefined;
				try {
					await repository.validateBranch(value);
					return undefined;
				} catch (error) {
					return message(error);
				}
			},
		});
		if (!branch) return;
		this.worktreeView.creating = branch;
		this.worktreeView.refresh();
		await vscode.window.withProgress(
			{ location: { viewId: "worky.worktrees" } },
			() =>
				vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `Worky: opening ${branch}`,
					},
					async () => {
						const result = await repository.create(branch);
						if (result.notice)
							this.notifications.show(
								`Worky: ${result.notice}`,
								"warning",
							);
						await this.refreshWorktrees(true);
						await this.open(result.worktree);
					},
				),
		);
	}

	private async duplicate(source?: Worktree): Promise<void> {
		if (this.creating) return;
		const selected =
			source ??
			this.worktreeView.items.find(
				(item) => item.path === this.worktreeView.currentPath,
			);
		if (!selected)
			throw new Error(
				"Open a worktree or select one in the Worktrees view first.",
			);
		this.creating = true;
		try {
			await this.withWorktreeActivity(
				selected,
				"Duplicating…",
				async () => {
					const repository = this.requireRepository();
					const branch = await this.duplicateBranch(selected);
					if (!branch) return;
					const sourcePath = await canonicalPath(selected.path);
					for (const document of vscode.workspace.textDocuments) {
						if (!document.isDirty || document.isUntitled) continue;
						const filename = document.uri.fsPath;
						if (
							isWithinDirectory(selected.path, filename) ||
							isWithinDirectory(
								sourcePath,
								await canonicalPath(filename),
							)
						)
							throw new Error(
								"Save the source worktree’s edited files before duplicating it.",
							);
					}
					this.worktreeView.creating = branch;
					this.worktreeView.refresh();
					const duplicate = await vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Notification,
							title: `Worky: duplicating ${selected.branch ?? "worktree"} as ${branch}`,
						},
						() => repository.duplicate(selected.path, branch),
					);
					await this.refreshWorktrees(true);
					await this.open(duplicate);
				},
			);
		} finally {
			this.creating = false;
			this.worktreeView.creating = undefined;
			this.worktreeView.refresh();
		}
	}

	private duplicateBranch(source: Worktree): Thenable<string | undefined> {
		const repository = this.requireRepository();
		return vscode.window.showInputBox({
			title: "Duplicate Worktree",
			prompt: `New branch for a copy of ${source.branch ?? "detached checkout"}, including saved changes and untracked files. Ignored files and automatic setup are excluded.`,
			value: `${source.branch ?? "worktree"}-copy`,
			ignoreFocusOut: true,
			validateInput: async (value) => {
				if (!value) return undefined;
				try {
					await repository.validateBranch(value);
					return undefined;
				} catch (error) {
					return message(error);
				}
			},
		});
	}

	private async openPullRequest(
		pr: PullRequest,
		newWindow = this.openInNewWindow,
	): Promise<void> {
		if (!this.pullRequestsEnabled) return;
		const key = pullRequestKey(pr);
		if (this.pullRequestView.activity.has(key)) return;
		const existing = this.worktreeView.items.find((worktree) =>
			matchesPullRequest(worktree, pr),
		);
		if (existing && this.worktreeView.activity.has(existing.path)) return;
		this.pullRequestView.activity.set(key, "Opening…");
		this.pullRequestView.refresh();
		try {
			const action = () =>
				this.checkoutPullRequest(pr, newWindow, Boolean(existing));
			if (existing)
				await this.withWorktreeActivity(existing, "Opening…", action);
			else await action();
		} finally {
			this.pullRequestView.activity.delete(key);
			this.pullRequestView.refresh();
		}
	}

	private async checkoutPullRequest(
		pr: PullRequest,
		newWindow: boolean,
		alreadyBusy: boolean,
	): Promise<void> {
		const branch =
			pr.headRepository.toLowerCase() === pr.repository.toLowerCase()
				? pr.headBranch
				: `pr-${pr.number}`;
		const result = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Worky: opening PR #${pr.number}`,
			},
			() => this.requireRepository().create(branch, pr),
		);
		await this.refreshWorktrees(true);
		if (result.notice) this.notifications.show(`Worky: ${result.notice}`);
		if (alreadyBusy) await this.openFolder(result.worktree, newWindow);
		else await this.open(result.worktree, newWindow);
	}

	private goTo(): void {
		this.requireRepository();
		const picker = vscode.window.createQuickPick<GoToItem>();
		picker.title = "Go to Worktree or Pull Request";
		picker.placeholder = "Search by branch, PR number, or title";
		picker.matchOnDescription = true;
		const newWindow = this.openInNewWindow;
		const windowButton: vscode.QuickInputButton = {
			iconPath: new vscode.ThemeIcon(
				newWindow ? "go-to-file" : "empty-window",
			),
			tooltip: newWindow
				? "Open in Current Window"
				: "Open in New Window",
		};
		const gitHubButton: vscode.QuickInputButton = {
			iconPath: new vscode.ThemeIcon("link-external"),
			tooltip: "Open on GitHub",
		};
		// Always shown, so a query matching nothing can still create. While searching it
		// goes last so that real matches keep Enter.
		const createItem: GoToItem = {
			label: "$(add) Create New Worktree…",
			alwaysShow: true,
		};
		let open = true;
		let searching = false;
		const update = () => {
			if (!open) return;
			searching = Boolean(picker.value);
			const { worktrees, pullRequests } = goToItems(
				this.worktreeView.items,
				this.pullRequestsEnabled ? this.pullRequestView.items : [],
				this.worktreeView.currentPath,
			);
			const withButtons = (item: GoToItem): GoToItem => ({
				...item,
				buttons: item.pullRequest
					? [windowButton, gitHubButton]
					: [windowButton],
			});
			picker.items = [
				...(searching ? [] : [createItem]),
				{
					label: "Worktrees",
					kind: vscode.QuickPickItemKind.Separator,
				},
				...worktrees.map(withButtons),
				...(pullRequests.length
					? [
							{
								label: "Pull Requests",
								kind: vscode.QuickPickItemKind.Separator,
							},
							...pullRequests.map(withButtons),
						]
					: []),
				...(searching
					? [
							{
								label: "",
								kind: vscode.QuickPickItemKind.Separator,
							},
							createItem,
						]
					: []),
			];
		};
		const go = (item: GoToItem, window = newWindow) => {
			picker.hide();
			const action =
				item === createItem
					? this.create(picker.value.trim() || undefined)
					: item.worktree
						? this.open(item.worktree, window)
						: item.pullRequest &&
							this.openPullRequest(item.pullRequest, window);
			void Promise.resolve(action).catch((error) => this.report(error));
		};
		picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (item) go(item);
		});
		picker.onDidTriggerItemButton(({ item, button }) => {
			if (button === windowButton) go(item, !newWindow);
			else if (item.pullRequest)
				void this.openPullRequestOnGitHub(item.pullRequest);
		});
		picker.onDidChangeValue(() => {
			if (Boolean(picker.value) !== searching) update();
		});
		picker.onDidHide(() => {
			open = false;
			picker.dispose();
		});
		update();
		picker.show();
		// Show what is already loaded at once; PRs load on demand if their view was never opened.
		picker.busy = true;
		void this.refresh()
			.catch((error) => this.log.appendLine(message(error)))
			.finally(() => {
				if (!open) return;
				picker.busy = false;
				update();
			});
	}

	private async remove(worktree: Worktree, teardown = true): Promise<void> {
		let failed: TeardownError | undefined;
		await this.withWorktreeActivity(worktree, "Deleting…", async () => {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Worky: deleting ${worktree.branch ?? "worktree"}`,
				},
				async () => {
					try {
						await this.requireRepository().remove(
							worktree.path,
							this.worktreeView.currentPath,
							teardown
								? (path) =>
										runTeardown(path, (line) =>
											this.log.appendLine(line),
										)
								: undefined,
						);
					} catch (error) {
						if (!(error instanceof TeardownError)) throw error;
						failed = error;
					}
				},
			);
			await this.refreshWorktrees(true);
		});
		if (!failed) return;
		const choice = await vscode.window.showWarningMessage(
			`${failed.message} Delete the worktree anyway?`,
			{ modal: true },
			"Delete Anyway",
			"Show Log",
		);
		if (choice === "Delete Anyway") await this.remove(worktree, false);
		else if (choice === "Show Log") this.log.show();
	}

	private citationDestination(worktree: Worktree): CitationDestination {
		const repository = this.requireRepository();
		return {
			worktree,
			store: new CitationStore(repository.state, worktree.path),
			choices: () => this.t3Client().citationChoices(worktree.path),
			send: (request, checkpoint) =>
				repository.state.withLock(`t3:${worktree.path}`, () =>
					this.t3Client().sendCitation(
						worktree,
						repository.mainPath,
						request,
						checkpoint,
					),
				),
		};
	}

	private t3Client(): T3Client {
		const config = vscode.workspace.getConfiguration("worky");
		const values = {
			serverUrl:
				config.get<string>("t3.serverUrl") || "http://127.0.0.1:3773",
			baseDirectory: expandHome(
				config.get<string>("t3.baseDirectory") || "~/.t3",
			),
			cliPath: config.get<string>("t3.cliPath")
				? expandHome(config.get<string>("t3.cliPath")!)
				: undefined,
		};
		const key = JSON.stringify(values);
		if (this.t3?.key !== key)
			this.t3 = { key, client: new T3Client(values) };
		return this.t3!.client;
	}

	private async openInT3(
		worktree: Worktree,
		newThread = false,
	): Promise<void> {
		await this.withWorktreeActivity(
			worktree,
			"Opening in T3…",
			async () => {
				const client = this.t3Client();
				const repository = this.requireRepository();
				const target = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `Worky: opening ${worktree.branch ?? "worktree"} in T3 Code`,
					},
					() =>
						repository.state.withLock(`t3:${worktree.path}`, () =>
							client.open(
								worktree,
								repository.mainPath,
								newThread,
							),
						),
				);
				this.log.appendLine(
					`T3: ${target.created ? "created" : "reused"} thread ${target.threadId} for ${worktree.path}`,
				);
				if (
					!(await vscode.env.openExternal(
						vscode.Uri.parse(target.url),
					))
				) {
					throw new Error(
						"Could not open T3 Code on your computer. Install T3 Code Nightly 20261012.3010 or newer and connect it to this remote environment.",
					);
				}
			},
		);
	}

	private async openCurrentInT3(newThread = false): Promise<void> {
		const current = await this.currentPath();
		const worktree = (await this.requireRepository().list(false)).find(
			(item) => item.path === current,
		);
		if (!worktree)
			throw new Error(
				"Open a worktree of this repository in this window first.",
			);
		await this.openInT3(worktree, newThread);
	}

	private async retry(worktree: Worktree): Promise<void> {
		await this.withWorktreeActivity(
			worktree,
			"Retrying setup…",
			async () => {
				if (!this.setup)
					throw new Error(
						"Worky is not connected to the repository.",
					);
				await this.setup.retry(worktree.path);
				await this.openFolder(worktree, this.openInNewWindow);
			},
		);
	}

	dispose(): void {
		this.pullRequestAbort?.abort();
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.disposables
			.reverse()
			.forEach((disposable) => disposable.dispose());
	}
}

export async function activate(
	context: vscode.ExtensionContext,
): Promise<Worky> {
	const worky = new Worky();
	context.subscriptions.push(worky);
	await worky.refresh();
	return worky;
}
