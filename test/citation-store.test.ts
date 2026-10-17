import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CitationStore } from "../src/citation-store";
import { StateStore, BusyError } from "../src/state";
import type { T3CitationRequest } from "../src/t3";

const citation = {
	file: "src/a.ts",
	startLine: 1,
	startColumn: 1,
	endLine: 2,
	endColumn: 1,
	language: "typescript",
	code: "const a = 1;\n",
	unsaved: true,
};
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "worky-citations-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const state = new StateStore(root);
	return {
		state,
		store: new CitationStore(state, "/worktree"),
		reopen: () => new CitationStore(new StateStore(root), "/worktree"),
	};
}

test("citation batches persist fenced snapshots per worktree and support editing and removal", async (t) => {
	const { store, reopen, state } = await fixture(t);
	await store.add(citation, "first comment");
	await store.add(
		{
			...citation,
			file: "b.md",
			language: "markdown",
			code: "```js\ncode\n```",
		},
		"nested fence",
	);
	const batch = await reopen().read();
	assert.equal(batch.items.length, 2);
	assert.ok(
		batch.items[0]!.markdown.includes("```typescript\nconst a = 1;\n```"),
	);
	assert.ok(
		batch.items[1]!.markdown.includes(
			"````markdown\n```js\ncode\n```\n````",
		),
	);
	assert.deepEqual(
		(await new CitationStore(state, "/other").read()).items,
		[],
	);
	assert.equal((await fs.stat(store.filename)).mode & 0o777, 0o600);
	await reopen().editMarkdown(
		batch.items[0]!.id,
		"edited\n\n```ts\nchanged code\n```",
		batch.items[0]!.markdown,
	);
	assert.ok((await store.read()).items[0]!.markdown.startsWith("edited\n"));
	await store.remove(batch.items[1]!.id);
	assert.equal((await reopen().read()).items.length, 1);
	await assert.rejects(store.clear(batch), /batch changed/);
	await store.clear(await store.read());
	assert.deepEqual((await reopen().read()).items, []);
});

test("one dispatch sends an ordered batch and clears only after acknowledgement", async (t) => {
	const { store, reopen } = await fixture(t);
	await store.add(citation, "first");
	await store.add(
		{ ...citation, file: "src/b.ts", code: "let b = 2;" },
		"second",
	);
	const batch = await store.read();
	let calls = 0;
	const sent = await store.send(
		batch.items,
		"Explain both",
		async (request) => {
			calls++;
			assert.ok(request.text.startsWith("Explain both\n\n## Citation 1"));
			assert.ok(request.text.includes("## Citation 2\n\nsecond"));
			assert.ok(
				request.text.indexOf("first") < request.text.indexOf("second"),
			);
			const persisted = await reopen().read();
			assert.equal(persisted.items.length, 2);
			assert.equal(
				persisted.pending?.request.messageId,
				request.messageId,
			);
			return "ack";
		},
	);
	assert.equal(calls, 1);
	assert.deepEqual(sent, { count: 2, result: "ack" });
	assert.deepEqual((await reopen().read()).items, []);
	assert.equal(
		await store.send(undefined, "", async () => {
			throw new Error("should not retry acknowledged batch");
		}),
		undefined,
	);
});

test("failed batches survive restart with pinned request and target while new citations stay for next send", async (t) => {
	const { store, reopen } = await fixture(t);
	await store.add(citation, "first");
	const batch = await store.read();
	let original!: T3CitationRequest;
	await assert.rejects(
		store.send(batch.items, "instruction", async (request, checkpoint) => {
			request.origin = "http://127.0.0.1:3773";
			request.target = {
				threadId: "pinned",
				environmentId: "env",
				created: false,
				url: "t3code://threads/env/pinned",
			};
			await checkpoint();
			original = structuredClone(request);
			throw new Error("lost acknowledgement");
		}),
		/lost acknowledgement/,
	);
	const restarted = reopen();
	await assert.rejects(
		restarted.editMarkdown(
			batch.items[0]!.id,
			"changed",
			batch.items[0]!.markdown,
		),
		/uncertain delivery/,
	);
	await assert.rejects(
		restarted.remove(batch.items[0]!.id),
		/uncertain delivery/,
	);
	await restarted.add({ ...citation, file: "new.ts" }, "new batch");
	await assert.rejects(
		restarted.send((await restarted.read()).items, "", async () => {}),
		/uncertain delivery/,
	);
	await restarted.send(undefined, "", async (request) => {
		assert.deepEqual(request, original);
		return "ack";
	});
	const remaining = await store.read();
	assert.equal(remaining.items.length, 1);
	assert.equal(remaining.items[0]!.citation.file, "new.ts");
	assert.equal(remaining.pending, undefined);
});

test("windows cannot send concurrently or silently change a batch during the send dialog", async (t) => {
	const { store, reopen } = await fixture(t);
	await store.add(citation, "first");
	const before = await store.read();
	await reopen().add(citation, "second window");
	await assert.rejects(
		store.send(before.items, "", async () => {}),
		/batch changed/,
	);
	const batch = await store.read();
	await store.send(batch.items, "", async () => {
		await assert.rejects(
			reopen().send(batch.items, "", async () => {}),
			BusyError,
		);
		await assert.rejects(reopen().add(citation, "concurrent"), BusyError);
	});
	assert.equal((await store.read()).items.length, 0);
});

test("direct Markdown edits are sent verbatim and stale editors cannot overwrite another window", async (t) => {
	const { store, reopen } = await fixture(t);
	await store.add(citation, "original");
	const item = (await store.read()).items[0]!;
	const edited =
		"My rewritten message\n\n```typescript\nconst replacement = true;\n```\n";
	await store.editMarkdown(item.id, edited, item.markdown);
	await assert.rejects(
		reopen().editMarkdown(item.id, "stale overwrite", item.markdown),
		/another window/,
	);
	const batch = await reopen().read();
	await store.send(batch.items, "", async (request) => {
		assert.equal(request.text, "## Citation 1\n\n" + edited);
		assert.ok(!request.text.includes("const a = 1;"));
	});
});

test("selected thread persists per worktree and pending retries cannot be retargeted", async (t) => {
	const { store, reopen, state } = await fixture(t);
	const selection = {
		kind: "thread" as const,
		threadId: "chosen",
		title: "Chosen conversation",
		origin: "http://127.0.0.1:3773",
		environmentId: "env",
	};
	await store.select(selection);
	assert.deepEqual((await reopen().read()).selection, selection);
	assert.equal(
		(await new CitationStore(state, "/other").read()).selection,
		undefined,
	);
	await store.add(citation, "selected");
	await assert.rejects(
		store.send(
			(await store.read()).items,
			"",
			async (request) => {
				assert.deepEqual(request.selection, selection);
				throw new Error("lost ack");
			},
			selection,
		),
		/lost ack/,
	);
	await assert.rejects(
		reopen().select({ ...selection, kind: "new" }),
		/pending batch/,
	);
	await reopen().send(undefined, "", async (request) => {
		assert.deepEqual(request.selection, selection);
	});
});

test("acknowledged snapshots keep late edits recoverable across windows and restarts", async (t) => {
	const { store, reopen } = await fixture(t);
	await store.add(citation, "original");
	const item = (await store.read()).items[0]!;
	await store.send([item], "", async () => "ack");
	const restarted = reopen();
	assert.equal((await restarted.read()).items.length, 0);
	assert.equal(
		(await restarted.read()).sentDrafts?.[0]!.markdown,
		item.markdown,
	);
	await restarted.editMarkdown(item.id, item.markdown, item.markdown);
	assert.equal(
		(await restarted.read()).items.length,
		0,
		"unchanged saves do not queue duplicates",
	);
	const lateEdit =
		item.markdown + "\nAn edit made while dispatch was in flight.\n";
	await restarted.editMarkdown(item.id, lateEdit, item.markdown);
	assert.equal((await store.read()).items[0]!.markdown, lateEdit);
	assert.equal((await store.read()).sentDrafts?.length, 0);
	await assert.rejects(
		reopen().editMarkdown(item.id, "stale other window", item.markdown),
		/another window/,
	);
	await restarted.send(
		(await restarted.read()).items,
		"",
		async (request) => {
			assert.ok(request.text.includes(lateEdit));
		},
	);
	assert.equal((await store.read()).items.length, 0);
	assert.equal(
		(await store.read()).sentDrafts?.length,
		1,
		"only the latest acknowledged snapshot backs this draft",
	);
});
