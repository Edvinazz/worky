import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runTeardown, TeardownError } from "../src/teardown";

async function worktree(teardown: unknown) {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "worky-teardown-")),
	);
	await fs.mkdir(path.join(root, "apps", "api"), { recursive: true });
	await fs.writeFile(
		path.join(root, "worky.json"),
		JSON.stringify({ teardown }),
	);
	return root;
}

test("teardown runs commands in order in their directories and logs their output", async (t) => {
	const root = await worktree([
		{ name: "First", cwd: "apps/api", command: "pwd; echo first >&2" },
		{ name: "Second", command: "echo second" },
	]);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const lines: string[] = [];
	await runTeardown(root, (line) => lines.push(line));
	// stdout and stderr arrive separately, so check each line rather than their interleaving.
	for (const line of [path.join(root, "apps", "api"), "first", "second"])
		assert.ok(lines.includes(line), line);
	assert.ok(
		lines.indexOf('Teardown "First": pwd; echo first >&2') <
			lines.indexOf('Teardown "Second": echo second'),
	);
	assert.ok(
		lines.indexOf("second") >
			lines.indexOf('Teardown "Second": echo second'),
	);
});

test("a failing teardown command stops the remaining ones", async (t) => {
	const root = await worktree([
		{ name: "Fails", command: "exit 3" },
		{ name: "Skipped", command: "touch skipped" },
	]);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await assert.rejects(
		runTeardown(root, () => {}),
		(error) => {
			assert.ok(error instanceof TeardownError);
			assert.match(error.message, /"Fails" failed with exit code 3/);
			return true;
		},
	);
	await assert.rejects(fs.stat(path.join(root, "skipped")), {
		code: "ENOENT",
	});
});

test("without teardown commands nothing runs", async (t) => {
	const root = await worktree(undefined);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const lines: string[] = [];
	await runTeardown(root, (line) => lines.push(line));
	assert.deepEqual(lines, []);
});
