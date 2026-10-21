import { test } from "node:test";
import assert from "node:assert/strict";
import { goToItems } from "../src/go-to";
import { PullRequest, Worktree } from "../src/model";

const worktree = (branch: string, extra: Partial<Worktree> = {}): Worktree => ({
	path: `/worktrees/${branch}`,
	head: "0123456789abcdef",
	branch,
	main: false,
	bare: false,
	source: "git",
	...extra,
});

const pr = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({
	number,
	title: `PLAN-${number} Change`,
	url: `https://github.com/example/apps/pull/${number}`,
	author: "author",
	draft: false,
	headBranch: `feature/PLAN-${number}`,
	headRepository: "example/apps",
	headSha: "abc",
	repository: "example/apps",
	reviewRequested: false,
	...extra,
});

test("folds checked-out PRs into their worktree so an identifier has one row", () => {
	const { worktrees, pullRequests } = goToItems(
		[
			worktree("main", { main: true }),
			worktree("feature/PLAN-1487"),
			worktree("gone", { prunable: "missing" }),
		],
		[pr(1487), pr(1500), pr(1501, { reviewRequested: true })],
		"/worktrees/main",
	);
	assert.deepEqual(
		worktrees.map((item) => [item.label, item.description]),
		[
			["$(check) main", "Current"],
			["$(git-branch) feature/PLAN-1487", "#1487 PLAN-1487 Change"],
		],
	);
	assert.equal(worktrees[1]?.pullRequest?.number, 1487);
	assert.deepEqual(
		pullRequests.map((item) => item.pullRequest?.number),
		[1501, 1500],
	);
	assert.equal(
		pullRequests[0]?.description,
		"Your review requested · feature/PLAN-1501 · author",
	);
});
