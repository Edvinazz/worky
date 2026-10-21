import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import {
	findT3Thread,
	listT3Threads,
	createCitationRequest,
	T3Client,
	t3CreateCommand,
	t3ThreadUrl,
	T3Snapshot,
	T3Thread,
} from "../src/t3";
import { Worktree } from "../src/model";

const worktree: Worktree = {
	path: "/repo/trees/PLAN-1",
	branch: "PLAN-1",
	head: "",
	main: false,
	bare: false,
	source: "git",
};
const model = {
	model: "example-model",
	instanceId: "example-instance",
	options: [{ name: "reasoning_effort", value: "high" }],
};
const thread = (id: string, extra: Partial<T3Thread> = {}): T3Thread => ({
	id,
	projectId: "apps",
	worktreePath: worktree.path,
	branch: "PLAN-1",
	modelSelection: model,
	runtimeMode: "approval-required",
	interactionMode: "default",
	updatedAt: "2026-10-12T10:00:00Z",
	...extra,
});
function snapshot(threads: T3Thread[] = []): T3Snapshot {
	return {
		projects: [
			{
				id: "apps",
				workspaceRoot: "/repo/main",
				defaultModelSelection: model,
			},
		],
		threads,
	};
}

test("T3 reuses the most recently visited exact worktree across project layouts", () => {
	const data = snapshot([
		thread("old"),
		thread("recent", { lastVisitedAt: "2026-10-12T12:00:00Z" }),
		thread("same-branch-elsewhere", {
			worktreePath: "/other/PLAN-1",
			updatedAt: "2026-10-12T15:00:00Z",
		}),
		thread("deleted", {
			deletedAt: "now",
			updatedAt: "2026-10-12T16:00:00Z",
		}),
		thread("archived", {
			archivedAt: "now",
			updatedAt: "2026-10-12T17:00:00Z",
		}),
		thread("subagent", {
			lastVisitedAt: "2026-10-12T17:30:00Z",
			lineage: { relationshipToParent: "subagent" },
		}),
		thread("fork-of-old", {
			updatedAt: "2026-10-12T11:00:00Z",
			lineage: { relationshipToParent: "fork" },
		}),
	]);
	assert.equal(findT3Thread(data, worktree.path)?.id, "recent");
	assert.deepEqual(
		listT3Threads(data, worktree.path).map((item) => item.id),
		["recent", "fork-of-old", "old"],
	);
	data.projects.push({ id: "standalone", workspaceRoot: worktree.path });
	data.threads.push(
		thread("standalone", {
			projectId: "standalone",
			worktreePath: null,
			lastVisitedAt: "2026-10-12T18:00:00Z",
		}),
	);
	assert.equal(findT3Thread(data, worktree.path)?.id, "standalone");
	assert.equal(findT3Thread(data, "/missing"), undefined);
});

test("T3 creates an idle thread in the existing checkout with project defaults", () => {
	const command = t3CreateCommand(snapshot(), worktree, "/repo/main");
	assert.equal(command.type, "thread.create");
	assert.equal(command.worktreePath, worktree.path);
	assert.equal(command.branch, "PLAN-1");
	assert.deepEqual(command.modelSelection, model);
	assert.equal(command.runtimeMode, "approval-required");
	assert.equal(command.message, undefined);
	assert.equal(command.workspaceStrategy, undefined);
	const data = snapshot([
		thread("previous", { runtimeMode: "full-access" }),
		thread("newer-subagent", {
			updatedAt: "2026-10-12T11:00:00Z",
			modelSelection: { ...model, model: "subagent-model" },
			lineage: { relationshipToParent: "subagent" },
		}),
	]);
	data.projects[0]!.defaultModelSelection = null;
	assert.deepEqual(
		t3CreateCommand(data, worktree, "/repo/main").modelSelection,
		model,
	);
	data.projects.push({
		id: "standalone",
		workspaceRoot: worktree.path,
		defaultModelSelection: model,
	});
	const standalone = t3CreateCommand(data, worktree, "/repo/main");
	assert.equal(standalone.projectId, "standalone");
	assert.equal(standalone.worktreePath, null);
});

test("T3 refuses unknown projects and missing model defaults", () => {
	assert.throws(
		() => t3CreateCommand(snapshot(), worktree, "/unknown"),
		/Add this repository/,
	);
	const data = snapshot();
	data.projects[0]!.defaultModelSelection = null;
	assert.throws(
		() => t3CreateCommand(data, worktree, "/repo/main"),
		/default model/,
	);
});

test("T3 links encode identifiers and authentication is restricted to loopback", () => {
	assert.equal(
		t3ThreadUrl("remote/a", "thread?#"),
		"t3code://threads/remote%2Fa/thread%3F%23",
	);
	for (const serverUrl of [
		"https://example.com",
		"http://127.0.0.1@evil.test",
		"http://localhost/path",
		"file:///tmp/t3",
	]) {
		assert.throws(
			() => new T3Client({ serverUrl, baseDirectory: "/unused" }),
			/loopback/,
		);
	}
});

async function serverFixture(
	data: T3Snapshot,
	options: {
		fail?: boolean;
		redirect?: boolean;
		busy?: boolean;
		dropMessageAck?: boolean;
		dropCreateAck?: boolean;
		statusFailure?: boolean;
		rejectMessage?: boolean;
	} = {},
) {
	const commands: Record<string, unknown>[] = [];
	const receipts = new Set<string>();
	const runs: { userMessageId: string; status: string }[] = [];
	let dropped = false;
	let issued = 0;
	const server = createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		if (req.url === "/.well-known/t3/environment") {
			res.end(
				JSON.stringify({
					environmentId: "remote",
					serverVersion: "test",
					orchestrationProtocolVersion: 2,
				}),
			);
			return;
		}
		assert.equal(req.headers.authorization, "Bearer test-token");
		assert.equal(req.headers["x-t3-orchestration-protocol"], "2");
		if (req.url === "/api/orchestration/shell") {
			if (options.redirect) {
				res.writeHead(302, { Location: "https://example.invalid" });
				res.end();
				return;
			}
			res.end(JSON.stringify(data));
			return;
		}
		if (req.url === "/api/auth/websocket-ticket") {
			assert.equal(req.method, "POST");
			res.end('{"ticket":"test-ticket"}');
			return;
		}
		if (req.url?.startsWith("/api/orchestration/threads/")) {
			res.writeHead(options.statusFailure ? 503 : 200);
			res.end(JSON.stringify({ projection: { runs } }));
			return;
		}
		res.writeHead(404);
		res.end("{}");
	});
	const sockets = new WebSocketServer({ server });
	sockets.on("connection", (socket, req) => {
		const url = new URL(req.url!, "http://localhost");
		assert.equal(url.searchParams.get("wsTicket"), "test-ticket");
		assert.equal(url.searchParams.get("orchestrationProtocol"), "2");
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString());
			assert.equal(message._tag, "Request");
			assert.equal(message.tag, "orchestration.dispatchCommand");
			commands.push(message.payload);
			if (options.fail) {
				socket.close();
				return;
			}
			if (
				options.rejectMessage &&
				message.payload.type === "message.dispatch"
			) {
				socket.send(
					JSON.stringify({
						_tag: "Exit",
						requestId: message.id,
						exit: { _tag: "Failure" },
					}),
				);
				return;
			}
			if (!receipts.has(message.payload.commandId)) {
				receipts.add(message.payload.commandId);
				if (message.payload.type === "thread.create")
					data.threads.push(
						thread(message.payload.threadId, message.payload),
					);
				else if (message.payload.type === "message.dispatch") {
					assert.deepEqual(message.payload.dispatchMode, {
						type: "queue_after_active",
					});
					assert.equal(message.payload.createdBy, "user");
					assert.equal(message.payload.modelSelection, undefined);
					runs.push({
						userMessageId: message.payload.messageId,
						status: options.busy ? "queued" : "running",
					});
				}
			}
			if (
				!dropped &&
				((options.dropMessageAck &&
					message.payload.type === "message.dispatch") ||
					(options.dropCreateAck &&
						message.payload.type === "thread.create"))
			) {
				dropped = true;
				socket.close();
				return;
			}
			socket.send(
				JSON.stringify([
					{
						_tag: "Exit",
						requestId: message.id,
						exit: { _tag: "Success", value: { sequence: 1 } },
					},
				]),
			);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as { port: number };
	const client = new T3Client(
		{
			serverUrl: `http://127.0.0.1:${address.port}`,
			baseDirectory: "/unused",
		},
		async () => {
			issued++;
			return "test-token";
		},
	);
	return {
		client,
		commands,
		runs,
		issued: () => issued,
		close: async () => {
			sockets.clients.forEach((socket) => socket.terminate());
			sockets.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

test("T3 authenticates, creates once for concurrent clicks, and then reuses the thread", async (t) => {
	const f = await serverFixture(snapshot());
	t.after(f.close);
	const [a, b] = await Promise.all([
		f.client.open(worktree, "/repo/main"),
		f.client.open(worktree, "/repo/main"),
	]);
	assert.deepEqual(a, b);
	assert.equal(a.created, true);
	assert.equal(a.url, t3ThreadUrl("remote", a.threadId));
	assert.equal(f.commands.length, 1);
	const reused = await f.client.open(worktree, "/repo/main");
	assert.equal(reused.created, false);
	assert.equal(reused.threadId, a.threadId);
	const fresh = await f.client.open(worktree, "/repo/main", true);
	assert.notEqual(fresh.threadId, a.threadId);
	assert.equal(f.commands.length, 2);
	assert.equal(f.issued(), 1, "short-lived token is reused in memory");
});

test("T3 reports dropped RPC connections and does not follow authenticated redirects", async (t) => {
	const failed = await serverFixture(snapshot(), { fail: true });
	t.after(failed.close);
	await assert.rejects(
		failed.client.open(worktree, "/repo/main"),
		/closed the connection/,
	);
	const redirected = await serverFixture(snapshot(), { redirect: true });
	t.after(redirected.close);
	await assert.rejects(redirected.client.snapshot(), /Cannot reach/);
});

test("citations reuse the latest exact-worktree thread and queue safely behind active work", async (t) => {
	for (const busy of [false, true]) {
		const f = await serverFixture(
			snapshot([
				thread("old"),
				thread("recent", { lastVisitedAt: "2026-10-13T12:00:00Z" }),
			]),
			{ busy },
		);
		t.after(f.close);
		const request = createCitationRequest(
			"Explain this code\n\nfile.ts:1–2\nconst value = 1;",
		);
		const result = await f.client.sendCitation(
			worktree,
			"/repo/main",
			request,
		);
		assert.equal(result.target.threadId, "recent");
		assert.equal(result.target.created, false);
		assert.equal(result.delivery, busy ? "queued" : "started");
		assert.equal(f.commands.length, 1);
		assert.equal(f.commands[0]!.text, request.text);
	}
});

test("citation retries preserve destination and IDs after lost create or message acknowledgement", async (t) => {
	for (const dropCreateAck of [false, true]) {
		const data = snapshot();
		const f = await serverFixture(data, {
			dropCreateAck,
			dropMessageAck: !dropCreateAck,
		});
		t.after(f.close);
		const request = createCitationRequest("citation");
		await assert.rejects(
			f.client.sendCitation(worktree, "/repo/main", request),
			/closed the connection/,
		);
		const target = request.target!.threadId;
		data.threads.push(
			thread("visited-while-retrying", {
				lastVisitedAt: "2026-10-14T12:00:00Z",
			}),
		);
		const result = await f.client.sendCitation(
			worktree,
			"/repo/main",
			request,
		);
		assert.equal(result.target.threadId, target);
		assert.equal(f.runs.length, 1, "one durable message despite retry");
		assert.equal(
			data.threads.filter((item) => item.id === target).length,
			1,
		);
		const duplicates = f.commands.filter(
			(item) =>
				item.type ===
				(dropCreateAck ? "thread.create" : "message.dispatch"),
		);
		assert.equal(duplicates.length, 2);
		assert.deepEqual(duplicates[0], duplicates[1]);
	}
});

test("citation acknowledgement survives status lookup failure; rejected sends remain failures", async (t) => {
	const f = await serverFixture(snapshot([thread("existing")]), {
		statusFailure: true,
	});
	t.after(f.close);
	assert.equal(
		(
			await f.client.sendCitation(
				worktree,
				"/repo/main",
				createCitationRequest("citation"),
			)
		).delivery,
		"sent",
	);
	const rejected = await serverFixture(snapshot([thread("existing")]), {
		rejectMessage: true,
	});
	t.after(rejected.close);
	await assert.rejects(
		rejected.client.sendCitation(
			worktree,
			"/repo/main",
			createCitationRequest("citation"),
		),
		/rejected the operation/,
	);
	assert.equal(rejected.runs.length, 0);
});

test("citation transport persists its destination before dispatch and refuses retry on a different server", async (t) => {
	const f = await serverFixture(snapshot());
	t.after(f.close);
	const request = createCitationRequest("batch");
	let checkpoints = 0;
	await assert.rejects(
		f.client.sendCitation(worktree, "/repo/main", request, async () => {
			checkpoints++;
			if (request.target) {
				assert.ok(request.createCommand);
				assert.equal(f.commands.length, 0);
				throw new Error("disk full");
			}
		}),
		/disk full/,
	);
	assert.equal(checkpoints, 2);
	assert.equal(
		f.commands.length,
		0,
		"no external mutation before durable destination",
	);
	const saved = JSON.parse(JSON.stringify(request));
	await f.client.sendCitation(worktree, "/repo/main", saved);
	assert.equal(f.runs.length, 1);
	const other = await serverFixture(snapshot());
	t.after(other.close);
	await assert.rejects(
		other.client.sendCitation(worktree, "/repo/main", saved),
		/server changed/,
	);
	assert.equal(other.commands.length, 0);
});

test("citation destinations list only matching active threads, choose an older thread, or force a new one", async (t) => {
	const data = snapshot([
		thread("recent", {
			title: "Recent",
			lastVisitedAt: "2026-10-15T12:00:00Z",
		}),
		thread("older", { title: "Older" }),
		thread("elsewhere", { worktreePath: "/other" }),
		thread("archived", { archivedAt: "now" }),
	]);
	const f = await serverFixture(data);
	t.after(f.close);
	const choices = await f.client.citationChoices(worktree.path);
	assert.deepEqual(
		choices.threads.map((thread) => thread.id),
		["recent", "older"],
	);
	const request = createCitationRequest("explicit older destination");
	request.selection = {
		kind: "thread",
		threadId: "older",
		title: "Older",
		origin: choices.origin,
		environmentId: choices.environmentId,
	};
	const selected = await f.client.sendCitation(
		worktree,
		"/repo/main",
		request,
	);
	assert.equal(selected.target.threadId, "older");
	const fresh = createCitationRequest("new destination");
	fresh.selection = {
		kind: "new",
		title: "New thread",
		origin: choices.origin,
		environmentId: choices.environmentId,
	};
	const created = await f.client.sendCitation(worktree, "/repo/main", fresh);
	assert.equal(created.target.created, true);
	assert.ok(!["recent", "older"].includes(created.target.threadId));
	const invalid = createCitationRequest("invalid destination");
	invalid.selection = { ...request.selection, threadId: "elsewhere" };
	const count = f.commands.length;
	await assert.rejects(
		f.client.sendCitation(worktree, "/repo/main", invalid),
		/no longer available/,
	);
	assert.equal(
		f.commands.length,
		count,
		"never silently falls back from an invalid explicit selection",
	);
});
