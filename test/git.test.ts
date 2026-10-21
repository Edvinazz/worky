import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	countChanges,
	directoryName,
	git,
	githubRepository,
	matchesPullRequest,
	parseWorktrees,
} from "../src/git";
import { PullRequest, WorktreeState } from "../src/model";
import { fixture } from "./fixture";

test("parses NUL-delimited paths, detached heads, locks, and T3 worktrees", () => {
	const items = parseWorktrees(
		'worktree /repo with spaces\0HEAD abc\0branch refs/heads/development\0\0worktree /home/wep/.t3/worktrees/apps/a\nquote"\0HEAD def\0detached\0locked in use\0\0',
	);
	assert.equal(items.length, 2);
	assert.equal(items[0]?.branch, "development");
	assert.equal(items[1]?.source, "t3");
	assert.equal(items[1]?.path, '/home/wep/.t3/worktrees/apps/a\nquote"');
	assert.equal(items[1]?.locked, "in use");
	assert.equal(items[1]?.branch, undefined);
});

test("names preserve ticket case and avoid slash, truncation, and folder collisions", () => {
	assert.equal(directoryName("PLAN-0010"), "PLAN-0010");
	assert.equal(directoryName("plan-0010"), "plan-0010");
	assert.notEqual(directoryName("feature/a"), directoryName("feature-a"));
	assert.notEqual(
		directoryName("a".repeat(100)),
		directoryName("a".repeat(99) + "b"),
	);
	assert.match(directoryName("feature/long name"), /^[A-Za-z0-9_-]+$/);
	assert.ok(directoryName("x".repeat(200)).length <= 51);
});

test("counts rename records once and parses GitHub remote URLs", () => {
	assert.equal(countChanges("R  new name\0old name\0?? hello\0 M file\0"), 3);
	assert.equal(
		githubRepository("git@github.com:example/project.git\n"),
		"example/project",
	);
	assert.equal(
		githubRepository("https://github.com/Luksys3/worky.git"),
		"Luksys3/worky",
	);
	assert.equal(
		githubRepository("ssh://git@github.com/example/project.git"),
		"example/project",
	);
	assert.equal(
		githubRepository("https://example.com/example/project.git"),
		undefined,
	);
});

test("creates from latest development, preserves branch name, and never reruns existing setup", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await fs.writeFile(
		path.join(f.repository, "tracked.txt"),
		"uncommitted main changes\n",
	);
	const created = await f.service.create("feature/lower-case");
	assert.equal(created.created, true);
	assert.equal(created.worktree.branch, "feature/lower-case");
	assert.equal(
		await fs.readFile(
			path.join(created.worktree.path, "tracked.txt"),
			"utf8",
		),
		"base\n",
	);
	assert.equal(created.worktree.state?.setup.status, "pending");
	const state = (await f.service.state.read(created.worktree.path))!;
	state.setup.status = "ready";
	await f.service.state.save(state);
	const reopened = await f.service.create("feature/lower-case");
	assert.equal(reopened.created, false);
	assert.equal(reopened.worktree.path, created.worktree.path);
	assert.equal(reopened.worktree.state?.setup.status, "ready");
});

test("recognizes remote-only branches and existing external worktrees without adding setup state", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await git(f.remote, ["branch", "PFM-42"]);
	const remote = await f.service.create("PFM-42");
	assert.equal(
		(
			await git(remote.worktree.path, [
				"rev-parse",
				"--abbrev-ref",
				"@{upstream}",
			])
		).trim(),
		"origin/PFM-42",
	);
	const external = path.join(
		f.root,
		".t3",
		"worktrees",
		"applications",
		"external",
	);
	await git(f.repository, [
		"worktree",
		"add",
		"-b",
		"t3/external",
		external,
		"development",
	]);
	const reopened = await f.service.create("t3/external");
	assert.equal(reopened.created, false);
	assert.equal(reopened.worktree.source, "t3");
	assert.equal(await f.service.state.read(external), undefined);
});

test("rejects invalid names and existing destination paths without overwriting", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	for (const invalid of [
		"../escape",
		"-bad",
		"hello world",
		"@{-1}",
		"refs/../bad",
	]) {
		await assert.rejects(f.service.create(invalid), /valid branch/);
	}
	const target = path.join(f.service.config.worktreesPath, "PLAN-1");
	await fs.mkdir(target, { recursive: true });
	await fs.writeFile(path.join(target, "keep"), "keep");
	await assert.rejects(
		f.service.create("PLAN-1"),
		/destination already exists/,
	);
	assert.equal(await fs.readFile(path.join(target, "keep"), "utf8"), "keep");
});

test("deletion refuses dirty, locked, main, and current worktrees; clean deletion keeps the branch", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const { worktree } = await f.service.create("PLAN-clean");
	await assert.rejects(f.service.remove(f.repository), /main checkout/);
	await assert.rejects(
		f.service.remove(worktree.path, worktree.path),
		/this window/,
	);
	await fs.writeFile(path.join(worktree.path, "new-file"), "important");
	await assert.rejects(
		f.service.remove(worktree.path),
		/changes or untracked/,
	);
	await fs.unlink(path.join(worktree.path, "new-file"));
	await fs.writeFile(path.join(worktree.path, "tracked.txt"), "changed");
	await assert.rejects(
		f.service.remove(worktree.path),
		/changes or untracked/,
	);
	await git(worktree.path, ["restore", "tracked.txt"]);
	await git(f.repository, ["worktree", "lock", worktree.path]);
	await assert.rejects(f.service.remove(worktree.path), /locked/);
	await git(f.repository, ["worktree", "unlock", worktree.path]);
	await fs.writeFile(
		path.join(worktree.path, ".env"),
		"fixture ignored config",
	);
	await f.service.remove(worktree.path);
	await assert.rejects(fs.stat(worktree.path), { code: "ENOENT" });
	await git(f.repository, ["show-ref", "--verify", "refs/heads/PLAN-clean"]);
	assert.equal(await f.service.state.read(worktree.path), undefined);
});

test("PR checkout fetches its head and reuses its existing worktree", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await git(f.remote, [
		"update-ref",
		"refs/pull/42/head",
		"refs/heads/development",
	]);
	const pr: PullRequest = {
		number: 42,
		title: "Example",
		url: "https://github.com/example/apps/pull/42",
		author: "author",
		draft: false,
		headBranch: "PLAN-42",
		headRepository: "example/apps",
		headSha: "",
		repository: "example/apps",
		reviewRequested: true,
	};
	const result = await f.service.create(pr.headBranch, pr);
	assert.equal(result.worktree.state?.pullRequest?.number, 42);
	assert.equal(matchesPullRequest(result.worktree, pr), true);
	const again = await f.service.create(pr.headBranch, pr);
	assert.equal(again.created, false);
	assert.equal(
		(
			await git(result.worktree.path, ["config", "branch.PLAN-42.merge"])
		).trim(),
		"refs/heads/PLAN-42",
	);
	await git(result.worktree.path, ["switch", "-c", "another-task"]);
	const changed = (await f.service.list(false)).find(
		(item) => item.path === result.worktree.path,
	)!;
	assert.equal(matchesPullRequest(changed, pr), false);
});

test("independent deletions overlap, retain branches, and isolate dirty-worktree failures", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const first = (await f.service.create("PLAN-delete-one")).worktree;
	const second = (await f.service.create("PLAN-delete-two")).worktree;
	const dirty = (await f.service.create("PLAN-keep-dirty")).worktree;
	await fs.writeFile(
		path.join(dirty.path, "tracked.txt"),
		"keep these edits",
	);
	const targets = new Set([first.path, second.path]);
	const entered = new Set<string>();
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const timer = setTimeout(release, 3000);
	t.after(() => clearTimeout(timer));
	const withLock = f.service.state.withLock.bind(f.service.state);
	t.mock.method(
		f.service.state,
		"withLock",
		<T>(key: string, action: () => Promise<T>) =>
			withLock(key, async () => {
				if (targets.has(key)) {
					entered.add(key);
					if (entered.size === 2) release();
					await barrier;
					assert.equal(
						entered.size,
						2,
						"both deletions acquire their locks before either completes",
					);
				}
				return action();
			}),
	);
	const results = await Promise.allSettled([
		f.service.remove(first.path),
		f.service.remove(second.path),
		f.service.remove(dirty.path),
	]);
	assert.equal(results[0]!.status, "fulfilled");
	assert.equal(results[1]!.status, "fulfilled");
	assert.equal(results[2]!.status, "rejected");
	assert.equal(
		await fs.readFile(path.join(dirty.path, "tracked.txt"), "utf8"),
		"keep these edits",
	);
	const remaining = await f.service.list(false);
	assert.ok(!remaining.some((item) => targets.has(item.path)));
	for (const worktree of [first, second]) {
		await git(f.repository, [
			"show-ref",
			"--verify",
			`refs/heads/${worktree.branch}`,
		]);
		assert.equal(await f.service.state.read(worktree.path), undefined);
	}
});

test("deletion cannot overlap creation or setup on the same worktree", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const target = path.join(f.service.config.worktreesPath, "PLAN-creating");
	const save = f.service.state.save.bind(f.service.state);
	t.mock.method(f.service.state, "save", async (state: WorktreeState) => {
		// The checkout exists now, but creation has not finished persisting setup state.
		await assert.rejects(f.service.remove(target), /already running/);
		return save(state);
	});
	const { worktree } = await f.service.create("PLAN-creating");
	await f.service.state.withLock(worktree.path, async () => {
		await assert.rejects(
			f.service.remove(worktree.path),
			/already running/,
		);
		const reopened = await f.service.create(worktree.branch!);
		assert.equal(
			reopened.created,
			false,
			"an existing setup can still be opened",
		);
	});
	await f.service.remove(worktree.path);
});

test("fork PRs can recreate a removed worktree while unrelated local branches are protected", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await git(f.remote, [
		"update-ref",
		"refs/pull/12/head",
		"refs/heads/development",
	]);
	const pr: PullRequest = {
		number: 12,
		title: "Fork",
		url: "https://github.com/example/apps/pull/12",
		author: "other",
		draft: false,
		headBranch: "development",
		headRepository: "other/apps",
		headSha: "",
		repository: "example/apps",
		reviewRequested: false,
	};
	const first = await f.service.create("pr-12", pr);
	await f.service.remove(first.worktree.path);
	const recreated = await f.service.create("pr-12", pr);
	assert.equal(recreated.created, true);
	assert.equal(matchesPullRequest(recreated.worktree, pr), true);
	await git(f.repository, ["branch", "pr-13"]);
	await assert.rejects(
		f.service.create("pr-13", { ...pr, number: 13 }),
		/not associated/,
	);
});

test("deletion runs teardown only after its checks pass and keeps the worktree when teardown fails", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const { worktree } = await f.service.create("PLAN-teardown");
	const calls: string[] = [];
	await fs.writeFile(path.join(worktree.path, "new-file"), "important");
	await assert.rejects(
		f.service.remove(worktree.path, undefined, async (target) => {
			calls.push(target);
		}),
		/changes or untracked/,
	);
	assert.equal(calls.length, 0);
	await fs.unlink(path.join(worktree.path, "new-file"));
	// A submodule Git still keeps for this worktree, which makes `git worktree remove` refuse it
	const modules = path.join(
		(await git(worktree.path, ["rev-parse", "--absolute-git-dir"])).trim(),
		"modules",
	);
	await fs.mkdir(modules);
	await assert.rejects(
		f.service.remove(worktree.path, undefined, async (target) => {
			calls.push(target);
		}),
		/submodules/,
	);
	assert.equal(calls.length, 0);
	await fs.rm(modules, { recursive: true });
	await assert.rejects(
		f.service.remove(worktree.path, undefined, async () => {
			throw new Error("teardown failed");
		}),
		/teardown failed/,
	);
	await fs.stat(worktree.path);
	await f.service.remove(worktree.path, undefined, async (target) => {
		calls.push(target);
	});
	assert.deepEqual(calls, [worktree.path]);
	await assert.rejects(fs.stat(worktree.path), { code: "ENOENT" });
});
