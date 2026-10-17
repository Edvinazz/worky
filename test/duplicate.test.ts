import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { promises as mutableFs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { directoryName, git } from "../src/git";
import { fixture } from "./fixture";

async function write(root: string, name: string, content: string | Buffer) {
	await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
	await fs.writeFile(path.join(root, name), content);
}

async function assertSameGitState(source: string, target: string) {
	for (const args of [
		["rev-parse", "HEAD"],
		["status", "--porcelain=v1", "-z", "-uall"],
		["ls-files", "--stage", "-z"],
		["diff", "--binary", "--no-ext-diff", "--no-textconv"],
		["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"],
	])
		assert.equal(
			await git(target, args),
			await git(source, args),
			args.join(" "),
		);
}

test("duplicates the main checkout, preserving staged and unstaged state while excluding ignored files", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const source = f.repository;
	for (const name of [
		"renamed.txt",
		"deleted.txt",
		"recreated.txt",
		"directory/old.txt",
		"file-to-directory",
		"run.sh",
	])
		await write(source, name, "base\n");
	await fs.symlink("tracked.txt", path.join(source, "tracked-link"));
	await git(source, ["add", "."]);
	await git(source, ["commit", "-m", "local base"]);
	await write(source, "tracked.txt", "staged\n");
	await git(source, ["add", "tracked.txt"]);
	await write(source, "tracked.txt", "staged and unstaged\n");
	await git(source, ["mv", "renamed.txt", "new-name.txt"]);
	await write(source, "new-name.txt", "renamed and edited\n");
	await fs.unlink(path.join(source, "deleted.txt"));
	await git(source, ["rm", "recreated.txt"]);
	await write(source, "recreated.txt", "untracked replacement\n");
	await write(source, "binary.bin", Buffer.from([0, 1, 255, 2]));
	await git(source, ["add", "binary.bin"]);
	await write(source, "binary.bin", Buffer.from([0, 3, 254, 4]));
	await write(source, "added.txt", "staged addition\n");
	await git(source, ["add", "added.txt"]);
	await write(source, "added.txt", "edited addition\n");
	await write(source, "intent.txt", "intent to add\n");
	await write(source, "missing-intent.txt", "intent to delete\n");
	await git(source, ["add", "-N", "intent.txt", "missing-intent.txt"]);
	await fs.unlink(path.join(source, "missing-intent.txt"));
	await fs.chmod(path.join(source, "run.sh"), 0o755);
	await fs.unlink(path.join(source, "tracked-link"));
	await fs.symlink("added.txt", path.join(source, "tracked-link"));
	await fs.symlink("missing-target", path.join(source, "untracked-link"));
	await fs.rm(path.join(source, "directory"), { recursive: true });
	await fs.symlink("apps", path.join(source, "directory"));
	await fs.unlink(path.join(source, "file-to-directory"));
	await write(source, "file-to-directory/child", "replacement directory\n");
	const unusual = 'new directory/quote"\nfile.txt';
	await write(source, unusual, "untracked\n");
	await write(source, ".env", "ignored configuration\n");
	await write(source, "node_modules/example/file", "ignored dependency\n");
	await write(
		source,
		"worky.json",
		'{"setup":[{"name":"Never run","command":"exit 1"}]}',
	);
	const indexPath = (
		await git(source, [
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			"index",
		])
	).trim();
	const beforeIndex = await fs.readFile(indexPath);
	const beforeStatus = await git(source, [
		"status",
		"--porcelain=v1",
		"-z",
		"-uall",
	]);
	const result = await f.service.duplicate(source, "feature/main-copy");
	assert.equal(result.branch, "feature/main-copy");
	assert.equal(
		result.path,
		path.join(
			f.service.config.worktreesPath,
			directoryName(result.branch!),
		),
	);
	await assertSameGitState(source, result.path);
	for (const name of [
		"tracked.txt",
		"binary.bin",
		"added.txt",
		"intent.txt",
		"recreated.txt",
		"new-name.txt",
		"worky.json",
		unusual,
		"file-to-directory/child",
	])
		assert.deepEqual(
			await fs.readFile(path.join(result.path, name)),
			await fs.readFile(path.join(source, name)),
			name,
		);
	for (const name of ["tracked-link", "untracked-link", "directory"])
		assert.equal(
			await fs.readlink(path.join(result.path, name)),
			await fs.readlink(path.join(source, name)),
		);
	assert.equal(
		(await fs.stat(path.join(result.path, "run.sh"))).mode & 0o777,
		0o755,
	);
	for (const name of [
		".env",
		"node_modules",
		"deleted.txt",
		"missing-intent.txt",
	])
		await assert.rejects(fs.lstat(path.join(result.path, name)), {
			code: "ENOENT",
		});
	assert.equal(result.state?.setup.status, "skipped");
	assert.deepEqual(result.state?.setup.tasks, {});
	assert.equal(result.state?.pullRequest, undefined);
	assert.deepEqual(
		await fs.readFile(indexPath),
		beforeIndex,
		"source index is never rewritten",
	);
	assert.equal(
		await git(source, ["status", "--porcelain=v1", "-z", "-uall"]),
		beforeStatus,
	);
	assert.equal(
		await fs.readFile(path.join(source, ".env"), "utf8"),
		"ignored configuration\n",
	);
});

test("duplicates external and detached worktrees from their local commits without fetching", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const source = path.join(f.root, "external");
	await git(f.repository, ["worktree", "add", "-b", "feature", source]);
	await write(source, "feature.txt", "local feature commit\n");
	await git(source, ["add", "."]);
	await git(source, ["commit", "-m", "local feature"]);
	await write(source, "feature.txt", "local edit\n");
	await write(source, "untracked.txt", "untracked feature\n");
	await fs.rename(f.remote, f.remote + "-offline");
	for (const branch of ["feature-copy", "detached-copy"]) {
		if (branch === "detached-copy")
			await git(source, ["switch", "--detach"]);
		const result = await f.service.duplicate(source, branch);
		await assertSameGitState(source, result.path);
		assert.notEqual(
			result.head,
			(await git(f.repository, ["rev-parse", "HEAD"])).trim(),
		);
		await assert.rejects(
			git(result.path, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
		);
	}
});

test("copies staged binary patches larger than the Git output buffer and preserves raw CRLF bytes", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const content = randomBytes(7 * 1024 * 1024);
	await write(f.repository, "large.bin", content);
	await write(f.repository, ".gitattributes", "crlf.txt text eol=crlf\n");
	await write(f.repository, "crlf.txt", "staged\r\n");
	await git(f.repository, ["add", "."]);
	await write(f.repository, "crlf.txt", "unstaged\r\n");
	const result = await f.service.duplicate(f.repository, "binary-copy");
	assert.deepEqual(
		await fs.readFile(path.join(result.path, "large.bin")),
		content,
	);
	assert.equal(
		await fs.readFile(path.join(result.path, "crlf.txt"), "utf8"),
		"unstaged\r\n",
	);
	assert.equal(
		await git(result.path, ["ls-files", "--stage"]),
		await git(f.repository, ["ls-files", "--stage"]),
	);
});

test("preserves intent-to-add executable and symlink modes, including deleted and type-changed files", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const scripts = ["intent.sh", "missing-intent.sh", "changed-mode.sh"];
	const links = ["intent-link", "missing-intent-link", "changed-type-link"];
	for (const name of scripts) {
		await write(f.repository, name, "#!/bin/sh\necho intent\n");
		await fs.chmod(path.join(f.repository, name), 0o755);
	}
	for (const name of links)
		await fs.symlink("tracked.txt", path.join(f.repository, name));
	await git(f.repository, ["add", "-N", "--", ...scripts, ...links]);
	await fs.unlink(path.join(f.repository, "missing-intent.sh"));
	await fs.unlink(path.join(f.repository, "missing-intent-link"));
	await fs.chmod(path.join(f.repository, "changed-mode.sh"), 0o644);
	await fs.unlink(path.join(f.repository, "changed-type-link"));
	await write(f.repository, "changed-type-link", "now a regular file\n");
	const sourceIndex = await fs.readFile(
		path.join(f.repository, ".git", "index"),
	);
	const result = await f.service.duplicate(f.repository, "intent-modes-copy");
	await assertSameGitState(f.repository, result.path);
	assert.deepEqual(
		await fs.readFile(path.join(f.repository, ".git", "index")),
		sourceIndex,
	);
	assert.equal(
		(await fs.stat(path.join(result.path, "intent.sh"))).mode & 0o777,
		0o755,
	);
	assert.equal(
		(await fs.stat(path.join(result.path, "changed-mode.sh"))).mode & 0o777,
		0o644,
	);
	assert.equal(
		await fs.readlink(path.join(result.path, "intent-link")),
		"tracked.txt",
	);
	assert.equal(
		await fs.readFile(path.join(result.path, "changed-type-link"), "utf8"),
		"now a regular file\n",
	);
	for (const name of ["missing-intent.sh", "missing-intent-link"])
		await assert.rejects(fs.lstat(path.join(result.path, name)), {
			code: "ENOENT",
		});
});

test("duplicates staged middle-line edits when the user configures zero-context diffs", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await write(f.repository, "tracked.txt", "one\ntwo\nthree\nfour\n");
	await git(f.repository, ["commit", "-am", "multiline base"]);
	await git(f.repository, ["config", "diff.context", "0"]);
	await write(f.repository, "tracked.txt", "one\nchanged\nthree\nfour\n");
	await git(f.repository, ["add", "tracked.txt"]);
	await write(f.repository, "tracked.txt", "one\nchanged\nunstaged\nfour\n");
	const result = await f.service.duplicate(f.repository, "zero-context-copy");
	await assertSameGitState(f.repository, result.path);
	assert.equal(
		(await git(f.repository, ["config", "diff.context"])).trim(),
		"0",
	);
});

test(
	"preserves macOS symlink permissions independently of the creation umask",
	{ skip: process.platform !== "darwin" },
	async (t) => {
		const f = await fixture();
		t.after(f.cleanup);
		const names = [
			"tracked-permissions-link",
			"untracked-permissions-link",
			"broken-permissions-link",
		];
		const modes = [0o777, 0o700, 0o711];
		for (const [i, name] of names.entries()) {
			await fs.symlink(
				i === 2 ? "absent" : "tracked.txt",
				path.join(f.repository, name),
			);
			await fs.lchmod(path.join(f.repository, name), modes[i]!);
		}
		await git(f.repository, ["add", names[0]!]);
		const targetMode = (
			await fs.stat(path.join(f.repository, "tracked.txt"))
		).mode;
		const result = await f.service.duplicate(
			f.repository,
			"symlink-permissions-copy",
		);
		await assertSameGitState(f.repository, result.path);
		for (const [i, name] of names.entries()) {
			assert.equal(
				(await fs.lstat(path.join(result.path, name))).mode & 0o777,
				modes[i],
			);
			assert.equal(
				(await fs.lstat(path.join(f.repository, name))).mode & 0o777,
				modes[i],
			);
			assert.equal(
				await fs.readlink(path.join(result.path, name)),
				i === 2 ? "absent" : "tracked.txt",
			);
		}
		assert.equal(
			(await fs.stat(path.join(result.path, "tracked.txt"))).mode,
			targetMode,
			"chmod must not follow the link",
		);
	},
);

test("rejects existing branches, destinations, missing sources, and targets inside the source", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await assert.rejects(
		f.service.duplicate(f.repository, "development"),
		/already exists/,
	);
	await assert.rejects(
		f.service.duplicate(f.repository, "../invalid"),
		/valid branch/,
	);
	await assert.rejects(
		f.service.duplicate(path.join(f.root, "missing"), "missing-copy"),
		/missing or unavailable/,
	);
	const target = path.join(f.service.config.worktreesPath, "existing");
	await write(target, "keep", "keep\n");
	await assert.rejects(
		f.service.duplicate(f.repository, "existing"),
		/destination already exists/,
	);
	assert.equal(
		await fs.readFile(path.join(target, "keep"), "utf8"),
		"keep\n",
	);
	f.service.config.worktreesPath = path.join(f.repository, "copies");
	await assert.rejects(
		f.service.duplicate(f.repository, "recursive"),
		/outside the source/,
	);
	await assert.rejects(fs.stat(f.service.config.worktreesPath), {
		code: "ENOENT",
	});
});

test("refuses busy sources and unsupported Git states without creating a branch", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await f.service.state.withLock(f.repository, () =>
		assert.rejects(
			f.service.duplicate(f.repository, "busy"),
			/already running/,
		),
	);
	const pending = (await f.service.create("pending")).worktree;
	await assert.rejects(
		f.service.duplicate(pending.path, "pending-copy"),
		/setup to finish/,
	);
	await git(f.repository, [
		"update-index",
		"--assume-unchanged",
		"tracked.txt",
	]);
	await assert.rejects(
		f.service.duplicate(f.repository, "flag-copy"),
		/assume-unchanged/,
	);
	await git(f.repository, [
		"update-index",
		"--no-assume-unchanged",
		"tracked.txt",
	]);
	const nested = path.join(f.repository, "nested");
	await fs.mkdir(nested);
	await git(nested, ["init"]);
	await assert.rejects(
		f.service.duplicate(f.repository, "nested-copy"),
		/nested repositories/,
	);
	await fs.rm(nested, { recursive: true });
	const head = (await git(f.repository, ["rev-parse", "HEAD"])).trim();
	await git(f.repository, [
		"update-index",
		"--add",
		"--cacheinfo",
		`160000,${head},submodule`,
	]);
	await assert.rejects(
		f.service.duplicate(f.repository, "submodule-copy"),
		/submodules/,
	);
	for (const branch of [
		"busy",
		"pending-copy",
		"flag-copy",
		"nested-copy",
		"submodule-copy",
	])
		await assert.rejects(
			git(f.repository, ["show-ref", "--verify", `refs/heads/${branch}`]),
		);
});

test("rolls back a duplicate and branch if state persistence fails, retaining the source", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await write(f.repository, "tracked.txt", "source edits\n");
	await write(f.repository, "new.txt", "source untracked\n");
	const before = await git(f.repository, ["status", "--porcelain"]);
	const target = path.join(f.service.config.worktreesPath, "failed-copy");
	t.mock.method(f.service.state, "save", async () => {
		await assert.rejects(f.service.remove(target), /already running/);
		await assert.rejects(f.service.remove(f.repository), /already running/);
		throw new Error("fixture persistence failure");
	});
	await assert.rejects(
		f.service.duplicate(f.repository, "failed-copy"),
		/fixture persistence failure/,
	);
	await assert.rejects(fs.stat(target), { code: "ENOENT" });
	await assert.rejects(
		git(f.repository, ["show-ref", "--verify", "refs/heads/failed-copy"]),
	);
	assert.equal((await f.service.list(false)).length, 1);
	assert.equal(await git(f.repository, ["status", "--porcelain"]), before);
	assert.equal(
		await fs.readFile(path.join(f.repository, "tracked.txt"), "utf8"),
		"source edits\n",
	);
	assert.equal(
		await fs.readFile(path.join(f.repository, "new.txt"), "utf8"),
		"source untracked\n",
	);
});

test("detects source edits during copying and removes the partial destination", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const copy = fs.copyFile;
	let edited = false;
	t.mock.method(
		mutableFs,
		"copyFile",
		async (...args: Parameters<typeof fs.copyFile>) => {
			await copy(...args);
			if (!edited) {
				edited = true;
				await write(f.repository, "tracked.txt", "concurrent edit\n");
			}
		},
	);
	await assert.rejects(
		f.service.duplicate(f.repository, "changed-copy"),
		/source changed/,
	);
	assert.equal(edited, true);
	assert.equal(
		await fs.readFile(path.join(f.repository, "tracked.txt"), "utf8"),
		"concurrent edit\n",
	);
	await assert.rejects(
		fs.stat(path.join(f.service.config.worktreesPath, "changed-copy")),
		{ code: "ENOENT" },
	);
	await assert.rejects(
		git(f.repository, ["show-ref", "--verify", "refs/heads/changed-copy"]),
	);
});

test("cleans up a claimed branch when Git cannot register the worktree", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const target = path.join(
		f.service.config.worktreesPath,
		"registration-failure",
	);
	const mkdir = mutableFs.mkdir;
	t.mock.method(
		mutableFs,
		"mkdir",
		async (...args: Parameters<typeof mkdir>) => {
			const result = await mkdir(...args);
			if (args[0] === target)
				await fs.writeFile(
					path.join(target, "block-registration"),
					"fixture",
				);
			return result;
		},
	);
	await assert.rejects(
		f.service.duplicate(f.repository, "registration-failure"),
		/already exists/,
	);
	await assert.rejects(fs.stat(target), { code: "ENOENT" });
	await assert.rejects(
		git(f.repository, [
			"show-ref",
			"--verify",
			"refs/heads/registration-failure",
		]),
	);
	assert.equal((await f.service.list(false)).length, 1);
	assert.equal(await git(f.repository, ["status", "--porcelain"]), "");
});

test("refuses an unfinished merge without changing its source state", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await git(f.repository, ["switch", "-c", "conflicting"]);
	await write(f.repository, "tracked.txt", "other branch\n");
	await git(f.repository, ["commit", "-am", "other branch"]);
	await git(f.repository, ["switch", "development"]);
	await write(f.repository, "tracked.txt", "main branch\n");
	await git(f.repository, ["commit", "-am", "main branch"]);
	await assert.rejects(git(f.repository, ["merge", "conflicting"]));
	const before = await git(f.repository, ["ls-files", "--stage"]);
	await assert.rejects(
		f.service.duplicate(f.repository, "merge-copy"),
		/Finish the merge/,
	);
	assert.equal(await git(f.repository, ["ls-files", "--stage"]), before);
	await assert.rejects(
		git(f.repository, ["show-ref", "--verify", "refs/heads/merge-copy"]),
	);
});
