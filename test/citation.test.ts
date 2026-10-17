import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCitation, gitCitationSource } from "../src/citation";

test("citation includes exact unsaved code, location, and optional comment with safe Markdown fences", () => {
	const citation = {
		file: "src/folder with spaces/file.ts",
		startLine: 5,
		startColumn: 3,
		endLine: 9,
		endColumn: 1,
		language: "typescript",
		code: "const sample = `literal`;\n```\n  untouched  \n",
		unsaved: true,
	};
	const text = formatCitation(citation, "Check this case");
	assert.ok(text.startsWith("Check this case\n\n"));
	assert.ok(
		text.includes(
			"src/folder with spaces/file.ts:5:3–9:1 (end position exclusive) [unsaved editor contents]",
		),
	);
	assert.ok(text.includes("````typescript\n" + citation.code + "````"));
	assert.ok(
		!formatCitation({ ...citation, unsaved: false }, "").includes(
			"unsaved",
		),
	);
	assert.ok(formatCitation(citation, "").startsWith("Code citation:"));
});

test("Git citation sources distinguish index and revisions without treating a historical view as a working file", () => {
	assert.deepEqual(
		gitCitationSource(JSON.stringify({ path: "/repo/old.ts", ref: "" })),
		{ file: "/repo/old.ts", source: "Git index (staged)" },
	);
	assert.equal(
		gitCitationSource(
			JSON.stringify({ path: "/repo/old.ts", ref: "abc123" }),
		).source,
		"Git revision abc123",
	);
	assert.equal(
		gitCitationSource(JSON.stringify({ path: "/repo/old.ts", ref: "~" }))
			.source,
		"Git comparison base (index or HEAD)",
	);
	assert.throws(() => gitCitationSource("{}"));
	assert.throws(() =>
		gitCitationSource(
			JSON.stringify({
				path: "/repo/submodule",
				ref: "index",
				submoduleOf: "/repo",
			}),
		),
	);
});
