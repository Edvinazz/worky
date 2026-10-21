import { spawn } from "node:child_process";
import { commandDirectory, readConfig } from "./config";

// Every teardown failure, so the extension can offer to delete the worktree anyway.
export class TeardownError extends Error {
	constructor(problem: string, cause?: unknown) {
		super(`${problem}. See the Worky log.`, { cause });
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Runs the worktree's own teardown commands one at a time, so a later command can rely on an earlier one.
export async function runTeardown(
	worktreePath: string,
	log: (line: string) => void,
): Promise<void> {
	let commands;
	try {
		commands = (await readConfig(worktreePath)).teardown ?? [];
	} catch (error) {
		log(`Teardown: ${message(error)}`);
		throw new TeardownError("Teardown could not read worky.json", error);
	}
	for (const { name, cwd, command } of commands) {
		log(`Teardown "${name}": ${command}`);
		let exitCode: number | null;
		try {
			const directory = await commandDirectory(worktreePath, cwd);
			exitCode = await new Promise<number | null>((resolve, reject) => {
				const child = spawn("bash", ["-c", command], {
					cwd: directory,
					stdio: ["ignore", "pipe", "pipe"],
				});
				for (const stream of [child.stdout, child.stderr]) {
					let partial = "";
					stream.setEncoding("utf8");
					stream.on("data", (chunk: string) => {
						const lines = (partial + chunk).split("\n");
						partial = lines.pop()!;
						lines.forEach(log);
					});
					stream.on("end", () => {
						if (partial) log(partial);
					});
				}
				child.on("error", reject);
				child.on("close", resolve);
			});
		} catch (error) {
			log(`Teardown "${name}": ${message(error)}`);
			throw new TeardownError(`Teardown "${name}" could not run`, error);
		}
		if (exitCode !== 0)
			throw new TeardownError(
				`Teardown "${name}" ${exitCode === null ? "was stopped" : `failed with exit code ${exitCode}`}`,
			);
	}
}
