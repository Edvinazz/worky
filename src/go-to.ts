import type { QuickPickItem } from "vscode";
import { matchesPullRequest } from "./git";
import { compareWorktrees, PullRequest, Worktree } from "./model";

export interface GoToItem extends QuickPickItem {
	worktree?: Worktree;
	pullRequest?: PullRequest;
}

/**
 * Searchable rows for the Go To picker. A PR that is already checked out is
 * folded into its worktree row, so pasting an identifier yields one result.
 */
export function goToItems(
	worktrees: Worktree[],
	pullRequests: PullRequest[],
	currentPath?: string,
): { worktrees: GoToItem[]; pullRequests: GoToItem[] } {
	const checkedOut = new Set<PullRequest>();
	const worktreeItems = worktrees
		.filter((worktree) => !worktree.bare && !worktree.prunable)
		.sort(compareWorktrees(currentPath))
		.map((worktree): GoToItem => {
			const pullRequest = pullRequests.find((pr) =>
				matchesPullRequest(worktree, pr),
			);
			if (pullRequest) checkedOut.add(pullRequest);
			const current = worktree.path === currentPath;
			const icon = current
				? "check"
				: worktree.main
					? "repo"
					: "git-branch";
			return {
				label: `$(${icon}) ${worktree.branch ?? `detached ${worktree.head.slice(0, 8)}`}`,
				description: [
					current ? "Current" : undefined,
					pullRequest
						? `#${pullRequest.number} ${pullRequest.title}`
						: undefined,
				]
					.filter(Boolean)
					.join(" · "),
				worktree,
				pullRequest,
			};
		});
	const pullRequestItems = pullRequests
		.filter((pr) => !checkedOut.has(pr))
		.sort((a, b) => Number(b.reviewRequested) - Number(a.reviewRequested))
		.map((pullRequest): GoToItem => ({
			label: `$(${pullRequest.draft ? "git-pull-request-draft" : "git-pull-request"}) #${pullRequest.number} ${pullRequest.title}`,
			description: [
				pullRequest.reviewRequested
					? "Your review requested"
					: undefined,
				pullRequest.headBranch,
				pullRequest.author,
			]
				.filter(Boolean)
				.join(" · "),
			pullRequest,
		}));
	return { worktrees: worktreeItems, pullRequests: pullRequestItems };
}
