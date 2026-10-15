import { PullRequest } from "./model";

export class GitHubError extends Error {}

interface GitHubPull {
	number: number;
	title: string;
	html_url: string;
	user: { login: string } | null;
	draft: boolean;
	head: { ref: string; sha: string; repo: { full_name: string } | null };
}

export class GitHubClient {
	constructor(
		private readonly token: string,
		private readonly request: typeof fetch = fetch,
		private readonly signal?: AbortSignal,
	) {}

	private async get(url: string): Promise<{ data: unknown; next?: string }> {
		this.signal?.throwIfAborted();
		const parsed = new URL(url, "https://api.github.com");
		if (parsed.origin !== "https://api.github.com")
			throw new GitHubError("Unexpected GitHub API pagination URL.");
		const response = await this.request(parsed, {
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "worky-vscode",
			},
			signal: this.signal
				? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
				: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			if (response.status === 401)
				throw new GitHubError("GitHub sign-in expired. Sign in again.");
			if (
				response.status === 403 &&
				response.headers.get("x-ratelimit-remaining") === "0"
			) {
				throw new GitHubError(
					"GitHub rate limit reached. Try refreshing later.",
				);
			}
			if (response.status === 403 || response.status === 404) {
				throw new GitHubError(
					"GitHub could not grant access to this repository. Check your account and organization access.",
				);
			}
			throw new GitHubError(
				`GitHub request failed (${response.status}). Try refreshing.`,
			);
		}
		const next = response.headers
			.get("link")
			?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
		return { data: await response.json(), next };
	}

	async list(
		repository: string,
	): Promise<{ pullRequests: PullRequest[]; reviewWarning?: string }> {
		const { data: viewerData } = await this.get("/user");
		const login = (viewerData as { login?: string }).login;
		if (!login)
			throw new GitHubError(
				"GitHub did not return the signed-in account.",
			);
		const pulls: GitHubPull[] = [];
		let url: string | undefined =
			`/repos/${repository}/pulls?state=open&sort=updated&direction=desc&per_page=100`;
		let pages = 0;
		while (url) {
			if (++pages > 100)
				throw new GitHubError(
					"Too many PR pages. Narrow the repository configuration.",
				);
			const result = await this.get(url);
			if (!Array.isArray(result.data))
				throw new GitHubError(
					"Unexpected GitHub pull request response.",
				);
			pulls.push(...(result.data as GitHubPull[]));
			url = result.next;
		}
		const requested = new Set<number>();
		let reviewWarning: string | undefined;
		try {
			const query = `repo:${repository} is:pr is:open review-requested:${login}`;
			url = `/search/issues?q=${encodeURIComponent(query)}&per_page=100`;
			pages = 0;
			while (url) {
				if (++pages > 10)
					throw new GitHubError(
						"GitHub returned too many review requests to mark all of them.",
					);
				const result = await this.get(url);
				const data = result.data as {
					items?: { number: number }[];
					incomplete_results?: boolean;
					total_count?: number;
				};
				if (
					!Array.isArray(data.items) ||
					data.incomplete_results ||
					(data.total_count ?? 0) > 1000
				) {
					throw new GitHubError(
						"GitHub could not return the complete review request list.",
					);
				}
				data.items.forEach((item) => requested.add(item.number));
				url = result.next;
			}
		} catch (error) {
			this.signal?.throwIfAborted();
			reviewWarning =
				error instanceof Error ? error.message : String(error);
			requested.clear();
		}
		return {
			pullRequests: pulls.map((pr) => ({
				number: pr.number,
				title: pr.title,
				url: pr.html_url,
				author: pr.user?.login ?? "unknown",
				draft: pr.draft,
				headBranch: pr.head.ref,
				headRepository: pr.head.repo?.full_name ?? "",
				headSha: pr.head.sha,
				repository,
				reviewRequested: requested.has(pr.number),
			})),
			reviewWarning,
		};
	}
}
