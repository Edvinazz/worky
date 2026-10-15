import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WorktreeState } from "./model";

export class BusyError extends Error {}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class StateStore {
	readonly directory: string;
	private writes = new Map<string, Promise<void>>();

	constructor(commonGitDirectory: string) {
		this.directory = path.join(commonGitDirectory, "worky");
	}

	private filename(key: string, extension: string): string {
		return path.join(
			this.directory,
			`${createHash("sha256").update(key).digest("hex")}.${extension}`,
		);
	}

	async read(worktreePath: string): Promise<WorktreeState | undefined> {
		try {
			const value = JSON.parse(
				await fs.readFile(this.filename(worktreePath, "json"), "utf8"),
			);
			// Preserve old task identities and receipt files; never reset a completed setup.
			if (value.version === 1 && value.setup?.apps) {
				value.setup.tasks = Object.fromEntries(
					Object.entries(value.setup.apps).map(([name, state]) => [
						name,
						{
							name,
							cwd: `apps/${name}`,
							command: "pnpm run setup",
							...(state as object),
						},
					]),
				);
				delete value.setup.apps;
				value.version = 2;
			}
			if (
				value.version !== 2 ||
				value.path !== worktreePath ||
				!value.setup ||
				!value.setup.tasks ||
				typeof value.setup.tasks !== "object" ||
				Array.isArray(value.setup.tasks) ||
				!Object.values(value.setup.tasks).every(
					(task: any) =>
						task &&
						typeof task.name === "string" &&
						typeof task.command === "string" &&
						typeof task.cwd === "string" &&
						typeof task.status === "string",
				)
			) {
				throw new Error("Unexpected setup state format.");
			}
			return value;
		} catch (error) {
			if (missing(error)) return undefined;
			throw new Error(
				`Cannot read Worky state for ${worktreePath}: ${String(error)}`,
			);
		}
	}

	async save(value: WorktreeState): Promise<void> {
		const content = JSON.stringify(value, null, 2) + "\n";
		const filename = this.filename(value.path, "json");
		const previous = this.writes.get(filename) ?? Promise.resolve();
		const writing = previous
			.catch(() => {})
			.then(async () => {
				await fs.mkdir(this.directory, { recursive: true });
				const temp = `${filename}.${randomUUID()}.tmp`;
				try {
					await fs.writeFile(temp, content, { mode: 0o600 });
					await fs.rename(temp, filename);
				} finally {
					await fs.unlink(temp).catch(() => {});
				}
			});
		this.writes.set(filename, writing);
		try {
			await writing;
		} finally {
			if (this.writes.get(filename) === writing)
				this.writes.delete(filename);
		}
	}

	async delete(worktreePath: string): Promise<void> {
		await fs.unlink(this.filename(worktreePath, "json")).catch((error) => {
			if (!missing(error)) throw error;
		});
	}

	async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
		await fs.mkdir(this.directory, { recursive: true });
		const filename = this.filename(key, "lock");
		const token = randomUUID();
		let acquired = false;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const handle = await fs.open(filename, "wx", 0o600);
				try {
					await handle.writeFile(
						JSON.stringify({ pid: process.pid, token }),
					);
				} finally {
					await handle.close();
				}
				acquired = true;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST")
					throw error;
				let owner: { pid: number; token: string };
				try {
					owner = JSON.parse(await fs.readFile(filename, "utf8"));
				} catch {
					throw new BusyError(
						"Another Worky operation is starting. Try again shortly.",
					);
				}
				if (!Number.isInteger(owner.pid) || owner.pid <= 0)
					throw new BusyError(
						"Worky found an invalid operation lock.",
					);
				try {
					process.kill(owner.pid, 0);
					throw new BusyError(
						"Another Worky operation is already running for this worktree.",
					);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH")
						throw error;
				}
				// Serialize stale-lock recovery: two windows must not unlink a newly acquired lock.
				const recovery = `${filename}.recovery`;
				let guard;
				try {
					guard = await fs.open(recovery, "wx", 0o600);
				} catch {
					throw new BusyError(
						"Another Worky window is recovering this operation. Try again shortly.",
					);
				}
				try {
					const current = JSON.parse(
						await fs.readFile(filename, "utf8").catch(() => "{}"),
					);
					if (current.token === owner.token)
						await fs.unlink(filename).catch(() => {});
				} finally {
					await guard.close();
					await fs.unlink(recovery).catch(() => {});
				}
			}
		}
		if (!acquired)
			throw new BusyError(
				"Another Worky operation is running. Try again shortly.",
			);
		try {
			return await action();
		} finally {
			const current = JSON.parse(
				await fs.readFile(filename, "utf8").catch(() => "{}"),
			);
			if (current.token === token)
				await fs.unlink(filename).catch(() => {});
		}
	}
}
