import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import {
	findT3Thread,
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
	]);
	assert.equal(findT3Thread(data, worktree.path)?.id, "recent");
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
	const data = snapshot([thread("previous", { runtimeMode: "full-access" })]);
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
	options: { fail?: boolean; redirect?: boolean } = {},
) {
	const commands: Record<string, unknown>[] = [];
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
			data.threads.push(
				thread(message.payload.threadId, message.payload),
			);
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
