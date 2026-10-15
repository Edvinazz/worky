import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git, Worktrees } from "../src/git";

export async function fixture() {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "worky-test-")),
	);
	const repository = path.join(root, "applications");
	const remote = path.join(root, "remote.git");
	await fs.mkdir(repository);
	await git(repository, ["init", "-b", "development"]);
	await git(repository, ["config", "user.name", "Worky Test"]);
	await git(repository, [
		"config",
		"user.email",
		"worky-test@example.invalid",
	]);
	await git(repository, ["config", "commit.gpgsign", "false"]);
	await git(repository, ["config", "core.hooksPath", "/dev/null"]);
	await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
	await fs.writeFile(
		path.join(repository, ".gitignore"),
		"node_modules/\n.env\n.vscode/\n",
	);
	for (const app of ["web", "api"]) {
		await fs.mkdir(path.join(repository, "apps", app), { recursive: true });
		await fs.writeFile(
			path.join(repository, "apps", app, "package.json"),
			JSON.stringify({ name: app, scripts: { setup: "echo fixture" } }),
		);
	}
	await fs.writeFile(
		path.join(repository, "worky.json"),
		JSON.stringify({
			baseBranch: "development",
			setup: ["web", "api"].map((name) => ({
				name,
				cwd: `apps/${name}`,
				command: "pnpm run setup",
			})),
		}),
	);
	await git(repository, ["add", "."]);
	// Test-only commits in a disposable repository; the Worky source repository is never committed.
	await git(repository, ["commit", "-m", "fixture"]);
	await git(root, ["clone", "--bare", repository, remote]);
	await git(repository, ["remote", "add", "origin", remote]);
	await git(repository, ["fetch", "origin"]);
	const service = await Worktrees.connect({
		repositoryPath: repository,
		worktreesPath: path.join(root, "worktrees"),
		baseBranch: "development",
		remote: "origin",
	});
	return {
		root,
		repository,
		remote,
		service,
		cleanup: () => fs.rm(root, { recursive: true, force: true }),
	};
}
