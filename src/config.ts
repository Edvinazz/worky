import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SetupCommand {
	name: string;
	cwd: string;
	command: string;
}
export interface ProjectConfig {
	baseBranch?: string;
	remote?: string;
	pullRequests?: { enabled?: boolean };
	setup: SetupCommand[];
	teardown?: SetupCommand[];
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		throw new Error(`${field} must be a nonempty string.`);
	return value;
}

export function parseConfig(value: unknown): ProjectConfig {
	if (!object(value)) throw new Error("worky.json must contain an object.");
	for (const key of Object.keys(value)) {
		if (
			![
				"$schema",
				"baseBranch",
				"remote",
				"pullRequests",
				"setup",
				"teardown",
			].includes(key)
		)
			throw new Error(`Unknown worky.json field: ${key}.`);
	}
	const config: ProjectConfig = { setup: [] };
	if (value.baseBranch !== undefined)
		config.baseBranch = string(value.baseBranch, "baseBranch");
	if (value.remote !== undefined)
		config.remote = string(value.remote, "remote");
	if (value.pullRequests !== undefined) {
		if (!object(value.pullRequests))
			throw new Error("pullRequests must be an object.");
		for (const key of Object.keys(value.pullRequests)) {
			if (key !== "enabled")
				throw new Error(`Unknown pullRequests field: ${key}.`);
		}
		const enabled = value.pullRequests.enabled;
		if (enabled !== undefined && typeof enabled !== "boolean")
			throw new Error("pullRequests.enabled must be a boolean.");
		config.pullRequests = enabled === undefined ? {} : { enabled };
	}
	if (value.setup !== undefined)
		config.setup = parseCommands(value.setup, "setup");
	if (value.teardown !== undefined)
		config.teardown = parseCommands(value.teardown, "teardown");
	return config;
}

function parseCommands(value: unknown, field: string): SetupCommand[] {
	if (!Array.isArray(value))
		throw new Error(`${field} must be an array of commands.`);
	const names = new Set<string>();
	return value.map((entry, index) => {
		const label = `${field}[${index}]`;
		if (!object(entry)) throw new Error(`${label} must be an object.`);
		for (const key of Object.keys(entry)) {
			if (!["name", "cwd", "command"].includes(key))
				throw new Error(`Unknown ${label} field: ${key}.`);
		}
		const name = string(entry.name, `${label}.name`).trim();
		if (names.has(name))
			throw new Error(`Duplicate ${field} command name: ${name}.`);
		names.add(name);
		const cwd =
			entry.cwd === undefined ? "." : string(entry.cwd, `${label}.cwd`);
		// Use portable repository-relative paths, also when this file was written on another OS.
		if (
			path.posix.isAbsolute(cwd) ||
			path.win32.isAbsolute(cwd) ||
			cwd.includes("\\") ||
			cwd.split("/").includes("..")
		) {
			throw new Error(
				`${label}.cwd must be a relative path inside the worktree.`,
			);
		}
		return {
			name,
			cwd,
			command: string(entry.command, `${label}.command`),
		};
	});
}

export async function readConfig(root: string): Promise<ProjectConfig> {
	const filename = path.join(root, "worky.json");
	try {
		return parseConfig(JSON.parse(await fs.readFile(filename, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { setup: [] };
		throw new Error(
			`Cannot load ${filename}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function commandDirectory(
	root: string,
	cwd: string,
): Promise<string> {
	const base = await fs.realpath(root);
	const directory = await fs.realpath(path.resolve(base, cwd));
	const relative = path.relative(base, directory);
	if (
		relative.startsWith(".." + path.sep) ||
		relative === ".." ||
		path.isAbsolute(relative) ||
		!(await fs.stat(directory)).isDirectory()
	) {
		throw new Error(`Setup directory must be inside the worktree: ${cwd}`);
	}
	return directory;
}
