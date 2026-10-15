import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StateStore, BusyError } from "../src/state";
import { WorktreeState } from "../src/model";
import { createHash } from "node:crypto";

test("state survives another extension instance and serializes writes", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "worky-state-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const store = new StateStore(root);
	const state: WorktreeState = {
		version: 2,
		path: "/example",
		branch: "PLAN-1",
		createdAt: new Date().toISOString(),
		setup: {
			status: "pending",
			updatedAt: new Date().toISOString(),
			tasks: {
				install: {
					name: "install",
					cwd: ".",
					command: "echo setup",
					status: "pending",
				},
			},
		},
	};
	const first = store.save(state);
	state.setup.status = "ready";
	const second = store.save(state);
	await Promise.all([first, second]);
	assert.equal(
		(await new StateStore(root).read("/example"))?.setup.status,
		"ready",
	);
	assert.equal(await store.read("/other"), undefined);
});

test("two windows cannot claim the same setup and locks release after failure", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "worky-state-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const a = new StateStore(root);
	const b = new StateStore(root);
	await a.withLock("/example", async () => {
		await assert.rejects(
			b.withLock("/example", async () => {}),
			BusyError,
		);
		await b.withLock("/different", async () => {});
	});
	await assert.rejects(
		a.withLock("/example", async () => {
			throw new Error("failure");
		}),
		/failure/,
	);
	await b.withLock("/example", async () => {});
});

test("old setup records migrate without resetting successes or changing run identities", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "worky-migrate-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const store = new StateStore(root);
	await fs.mkdir(store.directory);
	const filename = path.join(
		store.directory,
		createHash("sha256").update("/old").digest("hex") + ".json",
	);
	await fs.writeFile(
		filename,
		JSON.stringify({
			version: 1,
			path: "/old",
			branch: "old",
			createdAt: "2026-01-01",
			setup: {
				status: "failed",
				runId: "existing-run",
				updatedAt: "2026-01-01",
				apps: {
					web: { status: "ready", exitCode: 0 },
					api: { status: "failed", exitCode: 1 },
				},
			},
		}),
	);
	const migrated = (await store.read("/old"))!;
	assert.equal(migrated.version, 2);
	assert.equal(migrated.setup.runId, "existing-run");
	assert.equal(migrated.setup.tasks.web!.status, "ready");
	assert.deepEqual(migrated.setup.tasks.api, {
		name: "api",
		cwd: "apps/api",
		command: "pnpm run setup",
		status: "failed",
		exitCode: 1,
	});
	await store.save(migrated);
	assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).version, 2);
});
