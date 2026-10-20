import { spawn } from "node:child_process";
import { commandDirectory, readConfig } from "./config";

export class TeardownError extends Error {
	constructor(name: string, exitCode: number | null) {
		super(
			`Teardown "${name}" ${exitCode === null ? "was stopped" : `failed with exit code ${exitCode}`}. See the Worky log.`,
		);
	}
}

// Runs the worktree's own teardown commands one at a time, so a later command can rely on an earlier one.
export async function runTeardown(
	worktreePath: string,
	log: (line: string) => void,
): Promise<void> {
	for (const { name, cwd, command } of (await readConfig(worktreePath))
		.teardown ?? []) {
		log(`Teardown "${name}": ${command}`);
		const directory = await commandDirectory(worktreePath, cwd);
		const exitCode = await new Promise<number | null>((resolve, reject) => {
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
		if (exitCode !== 0) throw new TeardownError(name, exitCode);
	}
}
