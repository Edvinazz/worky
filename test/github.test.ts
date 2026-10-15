import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../src/github";

const pr = (number: number) => ({
	number,
	title: `PR ${number}`,
	html_url: `https://github.com/example/apps/pull/${number}`,
	user: { login: "author" },
	draft: number === 2,
	head: {
		ref: `PLAN-${number}`,
		sha: "abc",
		repo: { full_name: "example/apps" },
	},
});

test("paginates all PRs and marks review requests using the authenticated account", async () => {
	const urls: string[] = [];
	const request: typeof fetch = async (input) => {
		const url = String(input);
		urls.push(url);
		if (url.endsWith("/user")) return Response.json({ login: "me" });
		if (url.includes("/search/issues")) {
			assert.ok(decodeURIComponent(url).includes("review-requested:me"));
			return Response.json({
				items: [{ number: 2 }],
				total_count: 1,
				incomplete_results: false,
			});
		}
		if (url.endsWith("page=2")) return Response.json([pr(2)]);
		return Response.json([pr(1)], {
			headers: {
				link: '<https://api.github.com/repos/example/apps/pulls?page=2>; rel="next"',
			},
		});
	};
	const result = await new GitHubClient("test-token", request).list(
		"example/apps",
	);
	assert.equal(result.pullRequests.length, 2);
	assert.equal(result.pullRequests[0]?.reviewRequested, false);
	assert.equal(result.pullRequests[1]?.reviewRequested, true);
	assert.equal(result.pullRequests[1]?.draft, true);
	assert.equal(urls.length, 4);
});

test("review lookup failure retains PRs and reports unavailable badges", async () => {
	const request: typeof fetch = async (input) =>
		String(input).endsWith("/user")
			? Response.json({ login: "me" })
			: String(input).includes("/search/")
				? new Response("", { status: 403 })
				: Response.json([pr(1)]);
	const result = await new GitHubClient("token", request).list(
		"example/apps",
	);
	assert.equal(result.pullRequests.length, 1);
	assert.ok(result.reviewWarning);
});

test("pagination never sends credentials to a different host", async () => {
	const urls: string[] = [];
	const request: typeof fetch = async (input) => {
		urls.push(String(input));
		return String(input).endsWith("/user")
			? Response.json({ login: "me" })
			: Response.json([pr(1)], {
					headers: {
						link: '<https://example.invalid/steal>; rel="next"',
					},
				});
	};
	await assert.rejects(
		new GitHubClient("token", request).list("example/apps"),
		/Unexpected GitHub API/,
	);
	assert.equal(urls.length, 2);
});

test("cancellation stops an active GitHub request and prevents further requests", async () => {
	const controller = new AbortController();
	let calls = 0;
	const request: typeof fetch = async (_input, options) => {
		calls++;
		return new Promise((_resolve, reject) => {
			options!.signal!.addEventListener(
				"abort",
				() => reject(options!.signal!.reason),
				{ once: true },
			);
		});
	};
	const client = new GitHubClient("token", request, controller.signal);
	const pending = client.list("example/apps");
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
	await assert.rejects(client.list("example/apps"), { name: "AbortError" });
	assert.equal(calls, 1);
});

test("cancelling review lookup is not converted to a successful partial result", async () => {
	const controller = new AbortController();
	const request: typeof fetch = async (input) => {
		if (String(input).endsWith("/user"))
			return Response.json({ login: "me" });
		if (String(input).includes("/search/")) {
			controller.abort();
			throw controller.signal.reason;
		}
		return Response.json([pr(1)]);
	};
	await assert.rejects(
		new GitHubClient("token", request, controller.signal).list(
			"example/apps",
		),
		{ name: "AbortError" },
	);
});
