import * as esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runTests } from "@vscode/test-electron";

const root = process.cwd();
// Agent hosts may set this for their own Electron CLI; VS Code needs normal desktop mode.
delete process.env.ELECTRON_RUN_AS_NODE;
await fs.mkdir("test-results", { recursive: true });
await esbuild.build({
	entryPoints: ["test/prepare-integration.ts"],
	outfile: "test-results/prepare.cjs",
	bundle: true,
	platform: "node",
	format: "cjs",
});
await esbuild.build({
	entryPoints: ["test/integration.ts"],
	outfile: "test-results/integration.cjs",
	bundle: true,
	platform: "node",
	format: "cjs",
	external: ["vscode"],
});
const { prepare } = await import(
	pathToFileURL(path.join(root, "test-results/prepare.cjs")).href
);
const fixture = await prepare();
console.log("Integration fixture:", fixture.root);
const userData = path.join(fixture.root, "vscode-user");
await fs.mkdir(path.join(userData, "User"), { recursive: true });
await fs.writeFile(
	path.join(userData, "User", "settings.json"),
	JSON.stringify({
		"worky.worktreesPath": fixture.worktreesPath,
		"worky.shellPath": fixture.shell,
		"workbench.startupEditor": "none",
		"security.workspace.trust.enabled": false,
		"extensions.autoCheckUpdates": false,
		"extensions.autoUpdate": false,
		"update.mode": "none",
		"telemetry.telemetryLevel": "off",
		"terminal.integrated.enablePersistentSessions": false,
	}),
);
let success = false;
const macBinary = "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const executable =
	process.env.WORKY_VSCODE_EXECUTABLE ||
	((await fs.stat(macBinary).catch(() => undefined))
		? macBinary
		: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron");
try {
	for (const phase of ["first", "reopen"]) {
		await runTests({
			vscodeExecutablePath: executable,
			extensionDevelopmentPath: root,
			extensionTestsPath: path.join(root, "test-results/integration.cjs"),
			extensionTestsEnv: {
				WORKY_TEST_FIXTURE: path.join(fixture.root, "fixture.json"),
				WORKY_TEST_PHASE: phase,
			},
			launchArgs: [
				fixture.worktree,
				"--user-data-dir",
				userData,
				"--extensions-dir",
				path.join(fixture.root, "vscode-extensions"),
				"--skip-welcome",
				"--skip-release-notes",
				"--disable-workspace-trust",
				"--disable-updates",
			],
		});
		if (
			!(await fs
				.stat(path.join(fixture.root, `${phase}.passed`))
				.catch(() => undefined))
		)
			throw new Error(
				`Integration phase ${phase} did not report success.`,
			);
	}
	success = true;
} finally {
	if (success) await fs.rm(fixture.root, { recursive: true, force: true });
	else
		console.error(
			"Kept failed integration fixture for inspection:",
			fixture.root,
		);
}
