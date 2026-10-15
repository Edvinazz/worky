import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { Worktree } from "./model";

const execute = promisify(execFile);
const timeout = 15_000;

export interface T3Config {
	serverUrl: string;
	baseDirectory: string;
	cliPath?: string;
}
export interface T3Descriptor {
	environmentId: string;
	serverVersion: string;
	orchestrationProtocolVersion: number;
}
export interface T3Model {
	instanceId: string;
	model: string;
	options?: unknown;
}
export interface T3Project {
	id: string;
	workspaceRoot: string;
	deletedAt?: string | null;
	defaultModelSelection?: T3Model | null;
}
export interface T3Thread {
	id: string;
	projectId: string;
	worktreePath: string | null;
	branch: string | null;
	modelSelection: T3Model;
	runtimeMode: string;
	interactionMode: string;
	updatedAt: string;
	lastVisitedAt?: string | null;
	deletedAt?: string | null;
	archivedAt?: string | null;
}
export interface T3Snapshot {
	projects: T3Project[];
	threads: T3Thread[];
}
export interface T3Target {
	threadId: string;
	environmentId: string;
	url: string;
	created: boolean;
}

export function t3ThreadUrl(environmentId: string, threadId: string): string {
	if (!environmentId || !threadId)
		throw new Error("T3 returned an invalid thread identity.");
	return `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

function samePath(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b);
}
function recent(a: T3Thread, b: T3Thread): number {
	return (
		Date.parse(b.lastVisitedAt ?? b.updatedAt) -
		Date.parse(a.lastVisitedAt ?? a.updatedAt)
	);
}

export function findT3Thread(
	snapshot: T3Snapshot,
	worktreePath: string,
): T3Thread | undefined {
	const projects = new Map(
		snapshot.projects
			.filter((project) => !project.deletedAt)
			.map((project) => [project.id, project]),
	);
	return snapshot.threads
		.filter((thread) => {
			const project = projects.get(thread.projectId);
			return (
				project &&
				!thread.deletedAt &&
				!thread.archivedAt &&
				samePath(
					thread.worktreePath ?? project.workspaceRoot,
					worktreePath,
				)
			);
		})
		.sort(recent)[0];
}

export function t3CreateCommand(
	snapshot: T3Snapshot,
	worktree: Worktree,
	mainPath: string,
): Record<string, unknown> {
	const projects = snapshot.projects.filter((project) => !project.deletedAt);
	const project =
		projects.find((project) =>
			samePath(project.workspaceRoot, worktree.path),
		) ??
		projects.find((project) => samePath(project.workspaceRoot, mainPath));
	if (!project)
		throw new Error(
			"Add this repository to T3 Code on this machine first.",
		);
	const previous = snapshot.threads
		.filter(
			(thread) => thread.projectId === project.id && !thread.deletedAt,
		)
		.sort(recent)[0];
	const model = project.defaultModelSelection ?? previous?.modelSelection;
	if (!model?.instanceId || !model.model) {
		throw new Error(
			"Choose a default model or create a first conversation for this project in T3 Code, then try again.",
		);
	}
	return {
		type: "thread.create",
		commandId: randomUUID(),
		threadId: randomUUID(),
		projectId: project.id,
		createdBy: "user",
		creationSource: "web",
		title: worktree.branch ?? path.basename(worktree.path),
		modelSelection: model,
		runtimeMode: previous?.runtimeMode ?? "approval-required",
		interactionMode: "default",
		branch: worktree.branch ?? null,
		worktreePath: samePath(project.workspaceRoot, worktree.path)
			? null
			: worktree.path,
	};
}

export class T3Client {
	readonly origin: string;
	private access?: {
		token: string;
		environmentId: string;
		expiresAt: number;
	};
	private authenticating?: Promise<string>;
	private pending = new Map<string, Promise<T3Target>>();

	constructor(
		private readonly config: T3Config,
		private readonly issueToken?: (
			descriptor: T3Descriptor,
		) => Promise<string>,
	) {
		const url = new URL(config.serverUrl);
		// Tokens are minted from this machine's T3 installation and must never leave it.
		if (
			!["http:", "https:"].includes(url.protocol) ||
			!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		) {
			throw new Error(
				"T3 server URL must be a loopback origin, such as http://127.0.0.1:3773.",
			);
		}
		this.origin = url.origin;
	}

	async descriptor(): Promise<T3Descriptor> {
		const descriptor = await this.http<T3Descriptor>(
			"/.well-known/t3/environment",
		);
		if (
			!descriptor.environmentId ||
			!descriptor.serverVersion ||
			descriptor.orchestrationProtocolVersion !== 2
		) {
			throw new Error(
				"This T3 server does not support Worky’s integration (orchestration protocol 2).",
			);
		}
		return descriptor;
	}

	private async token(descriptor: T3Descriptor): Promise<string> {
		if (
			this.access?.environmentId === descriptor.environmentId &&
			this.access.expiresAt > Date.now()
		)
			return this.access.token;
		if (this.authenticating) return this.authenticating;
		this.authenticating = (async () => {
			let token: string;
			if (this.issueToken) token = await this.issueToken(descriptor);
			else {
				const environmentId = (
					await fs.readFile(
						path.join(
							this.config.baseDirectory,
							"userdata",
							"environment-id",
						),
						"utf8",
					)
				).trim();
				if (environmentId !== descriptor.environmentId)
					throw new Error(
						"T3 server and data directory refer to different environments. Check Worky’s T3 settings.",
					);
				if (!/^[a-zA-Z0-9._-]+$/.test(descriptor.serverVersion))
					throw new Error("T3 returned an invalid server version.");
				const cli =
					this.config.cliPath ||
					path.join(
						this.config.baseDirectory,
						"runtime",
						"versions",
						descriptor.serverVersion,
						"t3",
					);
				try {
					const result = await execute(
						cli,
						[
							"auth",
							"session",
							"issue",
							"--base-dir",
							this.config.baseDirectory,
							"--scope",
							"orchestration:read",
							"--scope",
							"orchestration:operate",
							"--ttl",
							"5m",
							"--label",
							"Worky",
							"--token-only",
						],
						{ timeout: 30_000, maxBuffer: 64 * 1024 },
					);
					token = result.stdout.trim();
				} catch {
					// CLI errors may include stdout containing a token; never surface them verbatim.
					throw new Error(
						"Could not authenticate with T3. Check worky.t3.cliPath and worky.t3.baseDirectory.",
					);
				}
			}
			if (!token || /\s/.test(token))
				throw new Error("T3 did not return a valid access token.");
			this.access = {
				token,
				environmentId: descriptor.environmentId,
				expiresAt: Date.now() + 4 * 60_000,
			};
			return token;
		})().finally(() => {
			this.authenticating = undefined;
		});
		return this.authenticating;
	}

	private async http<T>(
		route: string,
		token?: string,
		method = "GET",
	): Promise<T> {
		let response: Response;
		try {
			response = await fetch(this.origin + route, {
				method,
				redirect: "error",
				signal: AbortSignal.timeout(timeout),
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
					"x-t3-orchestration-protocol": "2",
				},
			});
		} catch {
			throw new Error(
				"Cannot reach T3 Code on this machine. Start its server or check worky.t3.serverUrl.",
			);
		}
		if (!response.ok) {
			if (response.status === 401 || response.status === 403)
				this.access = undefined;
			throw new Error(
				`T3 request failed (${response.status}). Check the server and Worky’s T3 settings.`,
			);
		}
		try {
			return (await response.json()) as T;
		} catch {
			throw new Error(
				"T3 returned an unexpected response. Check worky.t3.serverUrl.",
			);
		}
	}

	async snapshot(): Promise<{
		descriptor: T3Descriptor;
		snapshot: T3Snapshot;
	}> {
		const descriptor = await this.descriptor();
		const token = await this.token(descriptor);
		const snapshot = await this.http<T3Snapshot>(
			"/api/orchestration/shell",
			token,
		);
		if (
			!Array.isArray(snapshot.projects) ||
			!Array.isArray(snapshot.threads)
		)
			throw new Error("Unexpected T3 thread list.");
		return { descriptor, snapshot };
	}

	async dispatch(command: Record<string, unknown>): Promise<void> {
		const descriptor = await this.descriptor();
		const token = await this.token(descriptor);
		const { ticket } = await this.http<{ ticket: string }>(
			"/api/auth/websocket-ticket",
			token,
			"POST",
		);
		if (!ticket) throw new Error("T3 did not issue a connection ticket.");
		const url = new URL("/ws", this.origin);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("orchestrationProtocol", "2");
		url.searchParams.set("wsTicket", ticket);
		await new Promise<void>((resolve, reject) => {
			const socket = new WebSocket(url, {
				handshakeTimeout: timeout,
				maxPayload: 8 * 1024 * 1024,
			});
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.terminate();
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(
				() =>
					finish(
						new Error(
							"T3 did not acknowledge the thread operation. Try opening it again; Worky checks for an existing thread first.",
						),
					),
				timeout,
			);
			socket.on("open", () =>
				socket.send(
					JSON.stringify({
						_tag: "Request",
						id: "1",
						tag: "orchestration.dispatchCommand",
						payload: command,
						headers: [],
					}),
				),
			);
			socket.on("message", (data) => {
				try {
					const decoded = JSON.parse(data.toString());
					for (const value of Array.isArray(decoded)
						? decoded
						: [decoded]) {
						if (value._tag === "Ping")
							socket.send(JSON.stringify({ _tag: "Pong" }));
						if (
							value._tag === "Exit" &&
							String(value.requestId) === "1"
						) {
							// Do not print arbitrary server failures: they can contain request payloads.
							finish(
								value.exit?._tag === "Success"
									? undefined
									: new Error(
											"T3 could not create this thread. Check the project’s model and provider in T3 Code.",
										),
							);
						}
						if (
							value._tag === "Defect" ||
							value._tag === "ClientProtocolError"
						)
							finish(
								new Error(
									"T3’s connection protocol was not accepted.",
								),
							);
					}
				} catch {
					finish(new Error("Unexpected T3 connection response."));
				}
			});
			socket.on("error", () =>
				finish(new Error("Could not connect to T3’s thread service.")),
			);
			socket.on("close", () =>
				finish(
					new Error(
						"T3 closed the connection before acknowledging the operation.",
					),
				),
			);
		});
	}

	open(
		worktree: Worktree,
		mainPath: string,
		newThread = false,
	): Promise<T3Target> {
		const key = path.resolve(worktree.path);
		const pending = this.pending.get(key);
		if (pending) return pending;
		const operation = this.resolve(worktree, mainPath, newThread).finally(
			() => this.pending.delete(key),
		);
		this.pending.set(key, operation);
		return operation;
	}

	private async resolve(
		worktree: Worktree,
		mainPath: string,
		newThread: boolean,
	): Promise<T3Target> {
		if (worktree.prunable)
			throw new Error("This worktree’s directory is missing.");
		const { descriptor, snapshot } = await this.snapshot();
		const existing = newThread
			? undefined
			: findT3Thread(snapshot, worktree.path);
		if (existing)
			return {
				threadId: existing.id,
				environmentId: descriptor.environmentId,
				url: t3ThreadUrl(descriptor.environmentId, existing.id),
				created: false,
			};
		const command = t3CreateCommand(snapshot, worktree, mainPath);
		await this.dispatch(command);
		return {
			threadId: command.threadId as string,
			environmentId: descriptor.environmentId,
			url: t3ThreadUrl(
				descriptor.environmentId,
				command.threadId as string,
			),
			created: true,
		};
	}
}
