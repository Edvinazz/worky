import type { SetupCommand } from "./config";
export type AppStatus =
	"pending" | "running" | "ready" | "failed" | "interrupted";

export interface AppSetup extends SetupCommand {
	status: AppStatus;
	exitCode?: number;
	error?: string;
}

export interface WorktreeState {
	version: 2;
	path: string;
	branch: string;
	createdAt: string;
	pullRequest?: {
		repository: string;
		number: number;
		headRepository: string;
		headBranch: string;
	};
	setup: {
		status: AppStatus | "skipped";
		runId?: string;
		updatedAt: string;
		tasks: Record<string, AppSetup>;
		error?: string;
	};
}

export interface Worktree {
	path: string;
	head: string;
	branch?: string;
	main: boolean;
	locked?: string;
	prunable?: string;
	bare: boolean;
	source: "git" | "t3";
	createdAt?: Date;
	ageIsApproximate?: boolean;
	changes?: number;
	statusError?: string;
	state?: WorktreeState;
}

export interface PullRequest {
	number: number;
	title: string;
	url: string;
	author: string;
	draft: boolean;
	headBranch: string;
	headRepository: string;
	headSha: string;
	repository: string;
	reviewRequested: boolean;
}

export interface RepositoryConfig {
	repositoryPath: string;
	worktreesPath: string;
	baseBranch: string;
	remote: string;
}

export function setupStatus(
	values: Record<string, AppSetup>,
): AppStatus | "skipped" {
	const statuses = Object.values(values).map((task) => task.status);
	if (!statuses.length) return "skipped";
	if (statuses.every((s) => s === "ready")) return "ready";
	if (statuses.some((s) => s === "running" || s === "pending"))
		return "running";
	if (statuses.some((s) => s === "failed")) return "failed";
	return "interrupted";
}

/** Current checkout first, then the main checkout, then newest. */
export function compareWorktrees(
	currentPath?: string,
): (a: Worktree, b: Worktree) => number {
	return (a, b) =>
		Number(b.path === currentPath) - Number(a.path === currentPath) ||
		Number(b.main) - Number(a.main) ||
		(b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
}

export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
