import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig, readConfig, commandDirectory } from "../src/config";
import { git, Worktrees } from "../src/git";
import { fixture } from "./fixture";

test("accepts arbitrary commands and defaults cwd; rejects malformed config and escaping paths", () => {
	assert.deepEqual(
		parseConfig({ setup: [{ name: "API", command: "make prepare" }] }),
		{
			setup: [{ name: "API", command: "make prepare", cwd: "." }],
		},
	);
	for (const value of [
		null,
		[],
		{ steup: [] },
		{ setup: "bad" },
		{ setup: [{ name: "API" }] },
		{
			setup: [
				{ name: "A", command: "x" },
				{ name: "A", command: "y" },
			],
		},
		{ baseBranch: "" },
	]) {
		assert.throws(() => parseConfig(value));
	}
	for (const cwd of [
		"/tmp",
		"../other",
		"a/../../other",
		"C:\\temp",
		"\\\\server\\share",
		"a\\b",
	]) {
		assert.throws(
			() =>
				parseConfig({ setup: [{ name: "API", cwd, command: "make" }] }),
			/relative path/,
		);
	}
});

test("PR configuration accepts boolean overrides and rejects malformed feature flags", () => {
	for (const enabled of [true, false]) {
		assert.deepEqual(parseConfig({ pullRequests: { enabled } }), {
			setup: [],
			pullRequests: { enabled },
		});
	}
	assert.deepEqual(parseConfig({ pullRequests: {} }), {
		setup: [],
		pullRequests: {},
	});
	for (const pullRequests of [
		false,
		null,
		[],
		{ enabled: "false" },
		{ enabled: 0 },
		{ typo: false },
	]) {
		assert.throws(() => parseConfig({ pullRequests }), /pullRequests/);
	}
});

test("missing config skips setup; explicit config is used; invalid config fails", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "worky-config-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	assert.deepEqual(await readConfig(root), { setup: [] });
	for (const config of [{}, { setup: [] }]) {
		await fs.writeFile(
			path.join(root, "worky.json"),
			JSON.stringify(config),
		);
		assert.deepEqual(await readConfig(root), { setup: [] });
	}
	await fs.writeFile(
		path.join(root, "worky.json"),
		JSON.stringify({
			baseBranch: "main",
			setup: [{ name: "API", command: "make setup" }],
		}),
	);
	assert.deepEqual(await readConfig(root), {
		baseBranch: "main",
		setup: [{ name: "API", cwd: ".", command: "make setup" }],
	});
	await fs.writeFile(path.join(root, "worky.json"), "{bad");
	await assert.rejects(readConfig(root), /Cannot load.*worky.json/);
	await fs.symlink(path.dirname(root), path.join(root, "outside"));
	await assert.rejects(
		commandDirectory(root, "outside"),
		/inside the worktree/,
	);
	assert.equal(await commandDirectory(root, "."), await fs.realpath(root));
});

test("repository detection resolves a worktree subdirectory and discovers remote default branch", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const repository = await Worktrees.connect({
		...f.service.config,
		repositoryPath: path.join(f.repository, "apps/web"),
		baseBranch: "",
		remote: "",
	});
	assert.equal(repository.config.repositoryPath, f.repository);
	assert.equal(repository.config.baseBranch, "development");
	assert.equal(repository.config.remote, "origin");
	const created = await repository.create("feature/auto");
	const fromWorktree = await Worktrees.connect({
		...repository.config,
		repositoryPath: created.worktree.path,
	});
	assert.equal(fromWorktree.mainPath, f.repository);
});

test("setup comes from the destination branch, including absent and invalid config", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await git(f.repository, ["switch", "-c", "plain"]);
	await git(f.repository, ["rm", "worky.json"]);
	await git(f.repository, ["commit", "-m", "fixture without config"]);
	await git(f.repository, ["switch", "development"]);
	const plain = await f.service.create("plain");
	assert.equal(plain.worktree.state?.setup.status, "skipped");
	assert.deepEqual(plain.worktree.state?.setup.tasks, {});
	await fs.writeFile(path.join(plain.worktree.path, "worky.json"), "{bad");
	await git(plain.worktree.path, ["add", "worky.json"]);
	await git(plain.worktree.path, ["commit", "-m", "invalid fixture config"]);
	await git(f.repository, ["branch", "invalid", "plain"]);
	const invalid = await f.service.create("invalid");
	assert.equal(
		invalid.created,
		true,
		"checkout remains usable when its setup config is invalid",
	);
	assert.equal(invalid.worktree.state?.setup.status, "failed");
	assert.match(invalid.notice!, /worky.json/);
	// Uncommitted configuration in the main checkout is never copied to a new worktree.
	await fs.writeFile(
		path.join(f.repository, "worky.json"),
		JSON.stringify({ setup: [{ name: "Wrong branch", command: "false" }] }),
	);
	const normal = await f.service.create("normal");
	assert.deepEqual(Object.keys(normal.worktree.state!.setup.tasks), [
		"web",
		"api",
	]);
});

test("repositories without a remote can create worktrees from their local branch", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await git(f.repository, ["remote", "remove", "origin"]);
	const service = await Worktrees.connect({
		...f.service.config,
		remote: "",
		baseBranch: "",
	});
	assert.equal(service.config.remote, "");
	assert.equal(service.config.baseBranch, "development");
	assert.equal((await service.create("offline")).created, true);
});

test("teardown accepts the same commands as setup and rejects malformed entries", () => {
	assert.deepEqual(
		parseConfig({
			teardown: [{ name: "Databases", cwd: "apps/api", command: "x" }],
		}),
		{
			setup: [],
			teardown: [{ name: "Databases", cwd: "apps/api", command: "x" }],
		},
	);
	for (const teardown of [
		"bad",
		[{ name: "A" }],
		[{ name: "A", cwd: "../other", command: "x" }],
		[
			{ name: "A", command: "x" },
			{ name: "A", command: "y" },
		],
	]) {
		assert.throws(() => parseConfig({ teardown }));
	}
});
