import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	message,
	PullRequest,
	RepositoryConfig,
	Worktree,
	WorktreeState,
} from "./model";
import { StateStore } from "./state";
import { readConfig } from "./config";
import { canonicalPath } from "./paths";

const execute = promisify(execFile);

export class GitError extends Error {
	constructor(
		message: string,
		readonly code?: number | string,
	) {
		super(message);
	}
}

export async function git(
	cwd: string,
	args: string[],
	timeout = 30_000,
): Promise<string> {
	try {
		const { stdout } = await execute("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			timeout,
			maxBuffer: 8 * 1024 * 1024,
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
				GIT_OPTIONAL_LOCKS: "0",
			},
		});
		return stdout;
	} catch (error) {
		const failure = error as {
			stderr?: string;
			message: string;
			code?: number | string;
		};
		throw new GitError(
			failure.stderr?.trim() || failure.message,
			failure.code,
		);
	}
}

export function parseWorktrees(raw: string): Worktree[] {
	const result: Worktree[] = [];
	let item: Worktree | undefined;
	for (const field of raw.split("\0")) {
		if (field.startsWith("worktree ")) {
			const worktreePath = field.slice(9);
			item = {
				path: worktreePath,
				head: "",
				main: result.length === 0,
				bare: false,
				source: worktreePath.split(path.sep).includes(".t3")
					? "t3"
					: "git",
			};
			result.push(item);
		} else if (item) {
			if (field.startsWith("HEAD ")) item.head = field.slice(5);
			if (field.startsWith("branch refs/heads/"))
				item.branch = field.slice(18);
			if (field === "bare") item.bare = true;
			if (field === "locked" || field.startsWith("locked "))
				item.locked = field.slice(7) || "Locked by Git";
			if (field === "prunable" || field.startsWith("prunable "))
				item.prunable = field.slice(9) || "Missing worktree";
		}
	}
	return result;
}

export function countChanges(raw: string): number {
	const fields = raw.split("\0");
	let count = 0;
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (!field) continue;
		count++;
		if (/[RC]/.test(field.slice(0, 2))) i++;
	}
	return count;
}

export function directoryName(branch: string): string {
	// Keep short names readable; hash other names to avoid slash and truncation collisions.
	if (/^[A-Za-z0-9_-]{1,50}$/.test(branch)) return branch;
	const slug =
		branch
			.replace(/[^A-Za-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "worktree";
	return `${slug}-${createHash("sha256").update(branch).digest("hex").slice(0, 10)}`;
}

export function githubRepository(remote: string): string | undefined {
	const match = remote
		.trim()
		.match(
			/^(?:git@github\.com:|(?:https|ssh):\/\/(?:git@)?github\.com\/)([^/]+\/[^/]+?)\/?$/i,
		);
	return match?.[1]?.replace(/\.git$/i, "");
}

export function matchesPullRequest(
	worktree: Worktree,
	pr: PullRequest,
): boolean {
	const saved = worktree.state?.pullRequest;
	if (
		saved?.repository.toLowerCase() === pr.repository.toLowerCase() &&
		saved.number === pr.number &&
		worktree.branch === worktree.state?.branch
	)
		return true;
	return (
		pr.headRepository.toLowerCase() === pr.repository.toLowerCase() &&
		worktree.branch === pr.headBranch
	);
}

async function mapLimited<T, R>(
	items: T[],
	limit: number,
	callback: (item: T) => Promise<R>,
): Promise<R[]> {
	let next = 0;
	const output = new Array<R>(items.length);
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				output[index] = await callback(items[index]!);
			}
		}),
	);
	return output;
}

interface CheckoutFile {
	name: string;
	mode: number;
	link?: string;
	hash?: string;
}

async function fileHash(filename: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filename)) hash.update(chunk);
	return hash.digest("hex");
}

// Never follow a directory symlink while reading paths reported by the index.
// A tracked directory may have been replaced locally by a symlink or a file.
async function checkoutFile(
	root: string,
	name: string,
): Promise<CheckoutFile | undefined> {
	const parts = name.split("/");
	if (
		parts.some(
			(part) =>
				!part ||
				part === "." ||
				part === ".." ||
				part.toLowerCase() === ".git",
		)
	)
		throw new Error(`Cannot duplicate this repository path: ${name}`);
	try {
		for (let i = 1; i < parts.length; i++) {
			if (
				!(
					await fs.lstat(path.join(root, ...parts.slice(0, i)))
				).isDirectory()
			)
				return undefined;
		}
		const filename = path.join(root, name);
		const stat = await fs.lstat(filename);
		if (stat.isDirectory()) return undefined;
		const mode = stat.mode & 0o777;
		if (stat.isSymbolicLink())
			// Linux symlink permission bits cannot be changed; macOS supports lchmod.
			return {
				name,
				mode: process.platform === "darwin" ? mode : 0o777,
				link: await fs.readlink(filename),
			};
		if (!stat.isFile())
			throw new Error(`Cannot duplicate a special file: ${name}`);
		return { name, mode, hash: await fileHash(filename) };
	} catch (error) {
		if (
			["ENOENT", "ENOTDIR"].includes(
				(error as NodeJS.ErrnoException).code ?? "",
			)
		)
			return undefined;
		throw error;
	}
}

async function checkoutSnapshot(root: string) {
	const head = (await git(root, ["rev-parse", "HEAD"])).trim();
	const gitDirectory = (
		await git(root, ["rev-parse", "--absolute-git-dir"])
	).trim();
	for (const marker of [
		"MERGE_HEAD",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"rebase-merge",
		"rebase-apply",
		"sequencer",
	]) {
		try {
			await fs.lstat(path.join(gitDirectory, marker));
			throw new Error(
				"Finish the merge, rebase, or cherry-pick before duplicating this worktree.",
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const index = await git(root, ["ls-files", "--stage", "-z"]);
	if (index.split("\0").some((entry) => /^\d+ [a-f0-9]+ [123]\t/.test(entry)))
		throw new Error(
			"Resolve merge conflicts before duplicating this worktree.",
		);
	if (index.split("\0").some((entry) => entry.startsWith("160000 ")))
		throw new Error(
			"Duplicating worktrees with submodules is not supported yet.",
		);
	const flags = await git(root, ["ls-files", "-v", "-z"]);
	if (flags.split("\0").some((entry) => /^[a-zS] /.test(entry)))
		throw new Error(
			"Disable sparse checkout, skip-worktree, and assume-unchanged flags before duplicating this worktree.",
		);
	const additions = [
		"diff",
		"--cached",
		"--no-renames",
		"--name-only",
		"-z",
		"--diff-filter=A",
	];
	const staged = new Set(
		(await git(root, [...additions, "--ita-invisible-in-index"])).split(
			"\0",
		),
	);
	const intent = (await git(root, [...additions, "--ita-visible-in-index"]))
		.split("\0")
		.filter((name) => name && !staged.has(name));
	const names = [
		...new Set(
			(
				await git(root, [
					"ls-files",
					"--cached",
					"--others",
					"--exclude-standard",
					"-z",
				])
			)
				.split("\0")
				.filter(Boolean),
		),
	].sort();
	// ls-files reports an untracked nested repository as a directory, not its files.
	if (names.some((name) => name.endsWith("/")))
		throw new Error(
			"Duplicating worktrees with untracked nested repositories is not supported yet.",
		);
	const files = (
		await mapLimited(names, 4, (name) => checkoutFile(root, name))
	).filter((file): file is CheckoutFile => Boolean(file));
	return { head, index, flags, intent, files };
}

export class Worktrees {
	private constructor(
		readonly config: RepositoryConfig,
		readonly state: StateStore,
		readonly mainPath: string,
	) {}

	static async connect(config: RepositoryConfig): Promise<Worktrees> {
		config = {
			...config,
			repositoryPath: (
				await git(config.repositoryPath, [
					"rev-parse",
					"--show-toplevel",
				])
			).trim(),
		};
		const remotes = (await git(config.repositoryPath, ["remote"]))
			.trim()
			.split("\n")
			.filter(Boolean);
		if (!config.remote)
			config.remote = remotes.includes("origin")
				? "origin"
				: (remotes[0] ?? "");
		if (
			config.remote &&
			(config.remote.startsWith("-") || !remotes.includes(config.remote))
		)
			throw new Error(`Git remote “${config.remote}” does not exist.`);
		const common = (
			await git(config.repositoryPath, [
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			])
		).trim();
		const list = parseWorktrees(
			await git(config.repositoryPath, [
				"worktree",
				"list",
				"--porcelain",
				"-z",
			]),
		);
		if (!list[0]) throw new Error("The repository has no worktrees.");
		if (!config.baseBranch) {
			if (config.remote) {
				try {
					const head = (
						await git(config.repositoryPath, [
							"symbolic-ref",
							`refs/remotes/${config.remote}/HEAD`,
						])
					).trim();
					config.baseBranch = head.replace(
						`refs/remotes/${config.remote}/`,
						"",
					);
				} catch {
					const head = await git(
						config.repositoryPath,
						["ls-remote", "--symref", config.remote, "HEAD"],
						60_000,
					);
					config.baseBranch =
						head.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m)?.[1] ??
						"";
				}
			} else config.baseBranch = list[0].branch ?? "";
			if (!config.baseBranch)
				throw new Error(
					"Cannot determine the default branch. Set baseBranch in worky.json or Worky settings.",
				);
		}
		return new Worktrees(config, new StateStore(common), list[0].path);
	}

	async list(details = true): Promise<Worktree[]> {
		const worktrees = parseWorktrees(
			await git(this.config.repositoryPath, [
				"worktree",
				"list",
				"--porcelain",
				"-z",
			]),
		);
		return mapLimited(worktrees, 4, async (item) => {
			try {
				item.state = await this.state.read(item.path);
				const birth = (await fs.stat(item.path)).birthtime;
				const exact = item.state?.createdAt
					? new Date(item.state.createdAt)
					: undefined;
				if (exact && Number.isFinite(exact.getTime()))
					item.createdAt = exact;
				else if (birth.getTime() > 0) {
					item.createdAt = birth;
					item.ageIsApproximate = true;
				}
				if (details && !item.bare && !item.prunable) {
					item.changes = countChanges(
						await git(item.path, [
							"status",
							"--porcelain=v1",
							"-z",
							"--untracked-files=normal",
						]),
					);
				}
			} catch (error) {
				item.statusError = message(error);
			}
			return item;
		});
	}

	async validateBranch(branch: string): Promise<void> {
		if (!branch || branch !== branch.trim())
			throw new Error(
				"Enter a branch name without leading or trailing whitespace.",
			);
		try {
			const checked = (
				await git(this.config.repositoryPath, [
					"check-ref-format",
					"--branch",
					branch,
				])
			).trim();
			if (checked !== branch)
				throw new Error("Branch shortcuts are not supported.");
		} catch {
			throw new Error(`“${branch}” is not a valid branch name.`);
		}
	}

	private async refExists(ref: string): Promise<boolean> {
		try {
			await git(this.config.repositoryPath, [
				"show-ref",
				"--verify",
				"--quiet",
				ref,
			]);
			return true;
		} catch (error) {
			if (error instanceof GitError && error.code === 1) return false;
			throw error;
		}
	}

	private async fetchBranch(branch: string): Promise<void> {
		await this.validateBranch(branch);
		await git(
			this.config.repositoryPath,
			[
				"fetch",
				"--no-tags",
				this.config.remote,
				`+refs/heads/${branch}:refs/remotes/${this.config.remote}/${branch}`,
			],
			120_000,
		);
	}

	async remoteRepository(): Promise<string> {
		const remote = await git(this.config.repositoryPath, [
			"remote",
			"get-url",
			this.config.remote,
		]);
		const repository = githubRepository(remote);
		if (!repository)
			throw new Error("Worky currently supports github.com remotes.");
		return repository;
	}

	async duplicate(sourcePath: string, branch: string): Promise<Worktree> {
		await this.validateBranch(branch);
		return this.state.withLock("repository-mutation", () =>
			this.state.withLock(sourcePath, async () => {
				const source = (await this.list(false)).find(
					(item) => item.path === sourcePath,
				);
				if (!source || source.bare || source.prunable)
					throw new Error(
						"The source worktree is missing or unavailable. Refresh the list.",
					);
				if (
					["pending", "running"].includes(
						source.state?.setup.status ?? "",
					)
				)
					throw new Error(
						"Wait for setup to finish before duplicating this worktree.",
					);
				if (await this.refExists(`refs/heads/${branch}`))
					throw new Error(
						`Branch “${branch}” already exists. Choose a new branch name.`,
					);
				const target = path.join(
					await canonicalPath(
						path.resolve(this.config.worktreesPath),
					),
					directoryName(branch),
				);
				const relative = path.relative(
					await fs.realpath(sourcePath),
					target,
				);
				if (
					!relative ||
					(!relative.startsWith(".." + path.sep) &&
						relative !== ".." &&
						!path.isAbsolute(relative))
				)
					throw new Error(
						"The duplicate must be outside the source worktree. Change worky.worktreesPath.",
					);
				return this.state.withLock(target, async () => {
					try {
						await fs.lstat(target);
						throw new Error(
							`The destination already exists: ${target}`,
						);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT")
							throw error;
					}
					const snapshot = await checkoutSnapshot(sourcePath);
					const temp = await fs.mkdtemp(
						path.join(os.tmpdir(), "worky-duplicate-"),
					);
					let ownsDirectory = false;
					let ownsBranch = false;
					const repositoryGit = (args: string[]) =>
						git(
							this.config.repositoryPath,
							["-c", `core.hooksPath=${temp}`, ...args],
							120_000,
						);
					try {
						const patch = path.join(temp, "index.patch");
						const destinationGit = (args: string[]) =>
							git(
								target,
								["-c", `core.hooksPath=${temp}`, ...args],
								120_000,
							);
						// Write directly to disk: binary patches can exceed the Git helper's output buffer.
						await git(
							sourcePath,
							[
								"diff",
								"--cached",
								"--binary",
								"--unified=3",
								"--full-index",
								"--no-renames",
								"--no-ext-diff",
								"--no-textconv",
								"--ita-visible-in-index",
								"--src-prefix=a/",
								"--dst-prefix=b/",
								`--output=${patch}`,
								snapshot.head,
							],
							120_000,
						);
						// No checkout means no filters or checkout hooks can modify the copied files.
						await fs.mkdir(path.dirname(target), {
							recursive: true,
						});
						await fs.mkdir(target);
						ownsDirectory = true;
						// Claim the branch atomically and track ownership independently of registration.
						await repositoryGit([
							"update-ref",
							`refs/heads/${branch}`,
							snapshot.head,
							"",
						]);
						ownsBranch = true;
						await repositoryGit([
							"worktree",
							"add",
							"--no-checkout",
							"--",
							target,
							branch,
						]);
						await destinationGit(["read-tree", snapshot.head]);
						if ((await fs.stat(patch)).size)
							await destinationGit([
								"apply",
								"--cached",
								"--whitespace=nowarn",
								"--",
								patch,
							]);
						for (const file of snapshot.files) {
							if (
								JSON.stringify(
									await checkoutFile(sourcePath, file.name),
								) !== JSON.stringify(file)
							)
								throw new Error(
									"The source changed during duplication. Try again when files are no longer changing.",
								);
							const destination = path.join(target, file.name);
							await fs.mkdir(path.dirname(destination), {
								recursive: true,
							});
							if (file.link !== undefined) {
								await fs.symlink(file.link, destination);
								if (process.platform === "darwin")
									await fs.lchmod(destination, file.mode);
							} else {
								await fs.copyFile(
									path.join(sourcePath, file.name),
									destination,
									fs.constants.COPYFILE_EXCL,
								);
								await fs.chmod(destination, file.mode);
							}
							if (
								JSON.stringify(
									await checkoutFile(target, file.name),
								) !== JSON.stringify(file)
							)
								throw new Error(
									"A file changed while being copied. Try duplicating again.",
								);
						}
						// reset -N loses executable/symlink index modes. Rebuild intent entries
						// from placeholders with their original types, leaving actual files alone.
						const intentRoot = path.join(temp, "intent");
						const indexModes = new Map(
							snapshot.index
								.split("\0")
								.filter(Boolean)
								.map((entry) => [
									entry.slice(entry.indexOf("\t") + 1),
									entry.slice(0, 6),
								]),
						);
						for (const name of snapshot.intent) {
							const placeholder = path.join(intentRoot, name);
							await fs.mkdir(path.dirname(placeholder), {
								recursive: true,
							});
							if (indexModes.get(name) === "120000")
								await fs.symlink(
									"worky-intent-placeholder",
									placeholder,
								);
							else {
								await fs.writeFile(placeholder, "", {
									flag: "wx",
								});
								await fs.chmod(
									placeholder,
									indexModes.get(name) === "100755"
										? 0o755
										: 0o644,
								);
							}
						}
						for (let i = 0; i < snapshot.intent.length; i += 100) {
							const names = snapshot.intent.slice(i, i + 100);
							await destinationGit([
								"--literal-pathspecs",
								"update-index",
								"--force-remove",
								"--",
								...names,
							]);
							await destinationGit([
								"--literal-pathspecs",
								`--work-tree=${intentRoot}`,
								"-c",
								"core.filemode=true",
								"-c",
								"core.symlinks=true",
								"add",
								"-N",
								"--force",
								"--",
								...names,
							]);
						}
						if (
							JSON.stringify(await checkoutSnapshot(target)) !==
							JSON.stringify(snapshot)
						)
							throw new Error(
								"The copied files or staged changes do not match the source snapshot.",
							);
						if (
							JSON.stringify(
								await checkoutSnapshot(sourcePath),
							) !== JSON.stringify(snapshot)
						)
							throw new Error(
								"The source changed during duplication. Try again when files are no longer changing.",
							);
						const now = new Date().toISOString();
						const state: WorktreeState = {
							version: 2,
							path: target,
							branch,
							createdAt: now,
							setup: {
								status: "skipped",
								updatedAt: now,
								tasks: {},
							},
						};
						await this.state.save(state);
						return {
							path: target,
							branch,
							head: snapshot.head,
							main: false,
							bare: false,
							source: "git",
							state,
							createdAt: new Date(now),
						};
					} catch (error) {
						if (ownsDirectory) {
							try {
								const registered = parseWorktrees(
									await repositoryGit([
										"worktree",
										"list",
										"--porcelain",
										"-z",
									]),
								);
								if (
									registered.some(
										(item) => item.path === target,
									)
								)
									await repositoryGit([
										"worktree",
										"remove",
										"--force",
										"--",
										target,
									]);
								else
									await fs.rm(target, {
										recursive: true,
										force: true,
									});
								if (ownsBranch) {
									if (
										registered.some(
											(item) =>
												item.path !== target &&
												item.branch === branch,
										)
									)
										throw new Error(
											`Branch ${branch} is now in use by another worktree and was kept.`,
										);
									await repositoryGit([
										"update-ref",
										"-d",
										`refs/heads/${branch}`,
										snapshot.head,
									]);
								}
								await this.state.delete(target);
							} catch (cleanup) {
								throw new Error(
									`${message(error)} Cleanup failed for ${target} (branch ${branch}): ${message(cleanup)}`,
								);
							}
						}
						throw error;
					} finally {
						await fs.rm(temp, { recursive: true, force: true });
					}
				});
			}),
		);
	}

	async create(
		branch: string,
		pr?: PullRequest,
	): Promise<{ worktree: Worktree; created: boolean; notice?: string }> {
		await this.validateBranch(branch);
		return this.state.withLock("repository-mutation", async () => {
			const existing = (await this.list(false)).find((item) =>
				pr ? matchesPullRequest(item, pr) : item.branch === branch,
			);
			if (existing) {
				if (existing.prunable)
					throw new Error(
						`The registered worktree is missing: ${existing.path}`,
					);
				return { worktree: existing, created: false };
			}
			const localRef = `refs/heads/${branch}`;
			const localExists = await this.refExists(localRef);
			if (
				pr &&
				localExists &&
				pr.headRepository.toLowerCase() !== pr.repository.toLowerCase()
			) {
				let identity: string | undefined;
				try {
					identity = (
						await git(this.config.repositoryPath, [
							"config",
							"--get",
							`branch.${branch}.worky-pull-request`,
						])
					).trim();
				} catch (error) {
					if (!(error instanceof GitError && error.code === 1))
						throw error;
				}
				if (
					identity !== `${pr.repository.toLowerCase()}#${pr.number}`
				) {
					throw new Error(
						`Local branch ${branch} already exists but is not associated with this fork PR. Rename it before checking out this PR.`,
					);
				}
			}
			await fs.mkdir(this.config.worktreesPath, { recursive: true });
			const target = path.join(
				await fs.realpath(this.config.worktreesPath),
				directoryName(branch),
			);
			return this.state.withLock(target, async () => {
				try {
					await fs.lstat(target);
					throw new Error(
						`The destination already exists: ${target}`,
					);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT")
						throw error;
				}
				let start = localRef;
				let notice: string | undefined;
				if (pr) {
					const prRef = `refs/worky/pulls/${pr.number}`;
					await git(
						this.config.repositoryPath,
						[
							"fetch",
							"--no-tags",
							this.config.remote,
							`+refs/pull/${pr.number}/head:${prRef}`,
						],
						120_000,
					);
					start = prRef;
					if (localExists) {
						const localHead = (
							await git(this.config.repositoryPath, [
								"rev-parse",
								localRef,
							])
						).trim();
						const prHead = (
							await git(this.config.repositoryPath, [
								"rev-parse",
								prRef,
							])
						).trim();
						if (localHead !== prHead)
							notice = `Opened the existing local branch ${branch} without changing its commits. It differs from the PR head.`;
						start = localRef;
					}
				} else if (!localExists && !this.config.remote) {
					start = `refs/heads/${this.config.baseBranch}`;
				} else if (!localExists) {
					// Query the remote so branches absent from local tracking refs are recognized too.
					const remoteBranch = (
						await git(
							this.config.repositoryPath,
							[
								"ls-remote",
								"--heads",
								this.config.remote,
								`refs/heads/${branch}`,
							],
							60_000,
						)
					).trim();
					if (remoteBranch) {
						await this.fetchBranch(branch);
						start = `refs/remotes/${this.config.remote}/${branch}`;
					} else {
						await this.fetchBranch(this.config.baseBranch);
						start = `refs/remotes/${this.config.remote}/${this.config.baseBranch}`;
					}
				}
				const args = localExists
					? ["worktree", "add", "--", target, branch]
					: [
							"worktree",
							"add",
							"--no-track",
							"-b",
							branch,
							"--",
							target,
							start,
						];
				await git(this.config.repositoryPath, args, 120_000);
				if (
					pr &&
					pr.headRepository.toLowerCase() !==
						pr.repository.toLowerCase()
				) {
					await git(target, [
						"config",
						`branch.${branch}.worky-pull-request`,
						`${pr.repository.toLowerCase()}#${pr.number}`,
					]);
				}
				if (
					!localExists &&
					((!pr &&
						start ===
							`refs/remotes/${this.config.remote}/${branch}`) ||
						(pr &&
							pr.headRepository.toLowerCase() ===
								pr.repository.toLowerCase()))
				) {
					// A PR fetch need not create the normal remote-tracking ref. Set its push/pull target explicitly.
					await git(target, [
						"config",
						`branch.${branch}.remote`,
						this.config.remote,
					]);
					await git(target, [
						"config",
						`branch.${branch}.merge`,
						`refs/heads/${branch}`,
					]);
				}
				const now = new Date().toISOString();
				const state: WorktreeState = {
					version: 2,
					path: target,
					branch,
					createdAt: now,
					...(pr
						? {
								pullRequest: {
									repository: pr.repository,
									number: pr.number,
									headRepository: pr.headRepository,
									headBranch: pr.headBranch,
								},
							}
						: {}),
					setup: { status: "skipped", updatedAt: now, tasks: {} },
				};
				try {
					const config = await readConfig(target);
					state.setup.tasks = Object.fromEntries(
						config.setup.map((task) => [
							task.name,
							{ ...task, status: "pending" },
						]),
					);
					if (config.setup.length) state.setup.status = "pending";
				} catch (error) {
					state.setup.status = "failed";
					state.setup.error = message(error);
					notice = state.setup.error;
				}
				await this.state.save(state);
				const worktree = (await this.list(false)).find(
					(item) => item.path === target,
				);
				if (!worktree)
					throw new Error(
						`Created ${target}, but could not reload it from Git.`,
					);
				return { worktree, created: true, notice };
			});
		});
	}

	async remove(
		worktreePath: string,
		currentPath?: string,
		beforeRemove?: (worktreePath: string) => Promise<void>,
	): Promise<void> {
		if (worktreePath === currentPath)
			throw new Error(
				"Open another worktree before deleting the one in this window.",
			);
		// Each removal touches its own checkout and Git worktree metadata. Keep its setup
		// lock, while allowing independent checkouts to be removed at the same time.
		await this.state.withLock(worktreePath, async () => {
			const item = (await this.list(false)).find(
				(candidate) => candidate.path === worktreePath,
			);
			if (!item)
				throw new Error(
					"This worktree is no longer registered with Git. Refresh the list.",
				);
			if (item.main || item.bare)
				throw new Error("The main checkout cannot be deleted.");
			if (item.locked)
				throw new Error(`This worktree is locked: ${item.locked}`);
			if (item.prunable)
				throw new Error(
					"This directory is missing. Repair or prune its Git registration manually.",
				);
			const status = await git(item.path, [
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=normal",
			]);
			if (status)
				throw new Error(
					"This worktree has changes or untracked files. Commit, stash, or remove them before deleting it.",
				);
			// Git refuses to remove a worktree with checked-out submodules, like it checks them.
			const gitDirectory = (
				await git(item.path, ["rev-parse", "--absolute-git-dir"])
			).trim();
			const submodules = (
				await git(item.path, ["ls-files", "--stage", "-z"])
			)
				.split("\0")
				.filter((entry) => entry.startsWith("160000 "))
				.map((entry) => entry.slice(entry.indexOf("\t") + 1));
			for (const candidate of [
				path.join(gitDirectory, "modules"),
				...submodules.map((submodule) =>
					path.join(item.path, submodule, ".git"),
				),
			])
				if (await fs.lstat(candidate).catch(() => undefined))
					throw new Error(
						"Deleting worktrees with checked-out submodules is not supported yet.",
					);
			// Only after the checks, so teardown never removes the data of a worktree that stays.
			await beforeRemove?.(item.path);
			await git(
				this.config.repositoryPath,
				["worktree", "remove", "--", item.path],
				120_000,
			);
			await this.state.delete(item.path);
		});
	}
}
