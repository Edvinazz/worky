import * as vscode from "vscode";
import { matchesPullRequest } from "./git";
import { PullRequest, Worktree } from "./model";

export function ageLabel(date?: Date): string {
	if (!date || !Number.isFinite(date.getTime())) return "age unknown";
	const seconds = Math.max(
		0,
		Math.floor((Date.now() - date.getTime()) / 1000),
	);
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

export class InfoItem extends vscode.TreeItem {
	constructor(label: string, command?: string, tooltip?: string) {
		super(label);
		this.iconPath = new vscode.ThemeIcon("info");
		this.tooltip = tooltip ?? label;
		if (command) this.command = { command, title: label };
	}
}

export class LoadingItem extends InfoItem {
	constructor(label: string) {
		super(label);
		this.iconPath = new vscode.ThemeIcon("loading~spin");
	}
}

export interface WorktreeActivity {
	worktree: Worktree;
	label: string;
}
export function pullRequestKey(pr: PullRequest): string {
	return `${pr.repository}#${pr.number}`;
}

export class WorktreeItem extends vscode.TreeItem {
	constructor(
		readonly worktree: Worktree,
		currentPath?: string,
		activity?: string,
		baseBranch?: string,
		pullRequest?: PullRequest,
	) {
		const branch =
			worktree.branch ?? `detached ${worktree.head.slice(0, 8)}`;
		super(branch);
		this.id = worktree.path;
		const current = worktree.path === currentPath;
		const setup = worktree.state?.setup.status;
		const statusLabel = {
			pending: "Setup queued",
			running: "Setting up",
			ready: "Ready",
			failed: "Setup failed",
			interrupted: "Setup interrupted",
			skipped: undefined,
		};
		const details = [
			activity,
			worktree.main ? "Main" : undefined,
			current ? "Current" : undefined,
			worktree.main ? undefined : ageLabel(worktree.createdAt),
			worktree.prunable
				? "Missing"
				: worktree.locked
					? "Locked"
					: undefined,
			worktree.changes
				? `${worktree.changes} change${worktree.changes === 1 ? "" : "s"}`
				: undefined,
			setup ? statusLabel[setup] : undefined,
			worktree.statusError ? "Status unavailable" : undefined,
		].filter(Boolean);
		this.description = details.join(" · ");
		this.contextValue = activity
			? "worktree-busy"
			: [
					"worktree",
					!worktree.main &&
					!current &&
					!worktree.locked &&
					!worktree.prunable &&
					setup !== "running" &&
					setup !== "pending"
						? "removable"
						: "",
					setup === "failed" || setup === "interrupted"
						? "retry"
						: "",
				]
					.filter(Boolean)
					.join("-");
		this.iconPath = new vscode.ThemeIcon(
			activity || setup === "running"
				? "loading~spin"
				: current
					? "check"
					: worktree.main ||
						  (baseBranch && worktree.branch === baseBranch)
						? "repo"
						: "git-branch",
			!activity && (setup === "failed" || setup === "interrupted")
				? new vscode.ThemeColor("errorForeground")
				: undefined,
		);
		if (!activity)
			this.command = {
				command: "worky.open",
				title: "Open Worktree",
				arguments: [this],
			};
		const tooltip = new vscode.MarkdownString();
		tooltip.appendText(branch + "\n\n" + worktree.path);
		if (current && pullRequest)
			tooltip.appendText(
				`\n\nPR #${pullRequest.number}: ${pullRequest.title}`,
			);
		if (worktree.createdAt)
			tooltip.appendText(
				`\n\n${worktree.ageIsApproximate ? "Directory created (approximate)" : "Created"}: ${worktree.createdAt.toLocaleString()}`,
			);
		if (worktree.state) {
			if (worktree.state.setup.error)
				tooltip.appendText(`\n\n${worktree.state.setup.error}`);
			for (const appState of Object.values(worktree.state.setup.tasks)) {
				tooltip.appendText(
					`\n\n${appState.name}: ${appState.status}${appState.error ? ` — ${appState.error}` : ""}`,
				);
			}
		}
		if (worktree.statusError)
			tooltip.appendText("\n\n" + worktree.statusError);
		this.tooltip = tooltip;
	}
}

export class PullRequestItem extends vscode.TreeItem {
	constructor(
		readonly pullRequest: PullRequest,
		worktrees: Worktree[],
		activity?: string,
		currentPath?: string,
	) {
		super(`#${pullRequest.number} ${pullRequest.title}`);
		this.id = pullRequestKey(pullRequest);
		const existing = worktrees.find((item) =>
			matchesPullRequest(item, pullRequest),
		);
		const current = worktrees.some(
			(item) =>
				item.path === currentPath &&
				matchesPullRequest(item, pullRequest),
		);
		this.description = [
			activity,
			pullRequest.reviewRequested ? "Your review requested" : undefined,
			current ? "Current" : existing ? "Checked out" : undefined,
			pullRequest.draft ? "Draft" : undefined,
			pullRequest.author,
		]
			.filter(Boolean)
			.join(" · ");
		this.contextValue = activity ? "pullRequest-busy" : "pullRequest";
		this.iconPath = new vscode.ThemeIcon(
			activity
				? "loading~spin"
				: current
					? "check"
					: pullRequest.draft
						? "git-pull-request-draft"
						: "git-pull-request",
			!activity && !current && pullRequest.reviewRequested
				? new vscode.ThemeColor("notificationsWarningIcon.foreground")
				: undefined,
		);
		if (!activity)
			this.command = {
				command: "worky.openPullRequest",
				title: "Open PR in Worktree",
				arguments: [this],
			};
		this.tooltip = `${pullRequest.title}\n${pullRequest.headBranch}\nBy ${pullRequest.author}${existing ? `\nWorktree: ${existing.path}` : ""}${pullRequest.reviewRequested ? "\nYour review requested (directly or through a team)" : ""}`;
	}
}

export class WorktreesView implements vscode.TreeDataProvider<
	WorktreeItem | InfoItem
> {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;
	items: Worktree[] = [];
	readonly activity = new Map<string, WorktreeActivity>();
	creating?: string;
	currentPath?: string;
	currentPullRequest?: PullRequest;
	baseBranch?: string;
	error?: string;
	getTreeItem(item: WorktreeItem | InfoItem): vscode.TreeItem {
		return item;
	}
	getChildren(): (WorktreeItem | InfoItem)[] {
		if (this.error)
			return [
				new InfoItem(
					"Configure repository",
					"worky.settings",
					this.error,
				),
			];
		const items = new Map(this.items.map((item) => [item.path, item]));
		// Keep deleting rows visible until the operation and its refresh have finished.
		for (const [key, value] of this.activity)
			if (!items.has(key)) items.set(key, value.worktree);
		const rows: (WorktreeItem | InfoItem)[] = this.creating
			? [new LoadingItem(`Creating ${this.creating}…`)]
			: [];
		rows.push(
			...[...items.values()]
				.sort(
					(a, b) =>
						Number(b.path === this.currentPath) -
							Number(a.path === this.currentPath) ||
						Number(b.main) - Number(a.main) ||
						(b.createdAt?.getTime() ?? 0) -
							(a.createdAt?.getTime() ?? 0),
				)
				.map(
					(item) =>
						new WorktreeItem(
							item,
							this.currentPath,
							this.activity.get(item.path)?.label,
							this.baseBranch,
							this.currentPullRequest,
						),
				),
		);
		return rows.length ? rows : [new LoadingItem("Loading worktrees…")];
	}
	refresh(): void {
		this.emitter.fire();
	}
	dispose(): void {
		this.emitter.dispose();
	}
}

export class PullRequestsView implements vscode.TreeDataProvider<
	PullRequestItem | InfoItem
> {
	constructor(
		private readonly worktreeActivity: Map<string, WorktreeActivity>,
	) {}
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;
	items: PullRequest[] = [];
	readonly activity = new Map<string, string>();
	worktrees: Worktree[] = [];
	currentPath?: string;
	signedIn = false;
	loading = false;
	error?: string;
	reviewWarning?: string;
	getTreeItem(item: PullRequestItem | InfoItem): vscode.TreeItem {
		return item;
	}
	getChildren(): (PullRequestItem | InfoItem)[] {
		if (!this.signedIn)
			return [new InfoItem("Sign in to GitHub", "worky.signIn")];
		if (this.loading && !this.items.length)
			return [new LoadingItem("Loading pull requests…")];
		const rows: (PullRequestItem | InfoItem)[] = [];
		if (this.error)
			rows.push(
				new InfoItem(
					"Could not refresh PRs — click to retry",
					"worky.refresh",
					this.error,
				),
			);
		if (this.reviewWarning)
			rows.push(
				new InfoItem(
					"Review requests unavailable",
					"worky.refresh",
					this.reviewWarning,
				),
			);
		const current = this.worktrees.find(
			(item) => item.path === this.currentPath,
		);
		rows.push(
			...[...this.items]
				.sort(
					(a, b) =>
						Number(
							Boolean(current && matchesPullRequest(current, b)),
						) -
							Number(
								Boolean(
									current && matchesPullRequest(current, a),
								),
							) ||
						Number(b.reviewRequested) - Number(a.reviewRequested),
				)
				.map((item) => {
					const existing = this.worktrees.find((worktree) =>
						matchesPullRequest(worktree, item),
					);
					const activity =
						this.activity.get(pullRequestKey(item)) ??
						(existing &&
							this.worktreeActivity.get(existing.path)?.label);
					return new PullRequestItem(
						item,
						this.worktrees,
						activity,
						this.currentPath,
					);
				}),
		);
		if (!rows.length) rows.push(new InfoItem("No open pull requests"));
		return rows;
	}
	refresh(): void {
		this.emitter.fire();
	}
	dispose(): void {
		this.emitter.dispose();
	}
}
