export interface CodeCitation {
	source?: string;
	file: string;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	language: string;
	code: string;
	unsaved: boolean;
}

export function citationLocation(citation: CodeCitation): string {
	return `${citation.file}:${citation.startLine}:${citation.startColumn}–${citation.endLine}:${citation.endColumn}`;
}

export function formatCitation(
	citation: CodeCitation,
	comment: string,
): string {
	const longestFence = Math.max(
		0,
		...Array.from(
			citation.code.matchAll(/`+/g),
			(match) => match[0].length,
		),
	);
	const fence = "`".repeat(Math.max(3, longestFence + 1));
	const language = citation.language.replace(/[^a-zA-Z0-9_+-]/g, "");
	return [
		comment.trim(),
		`Code citation: ${citationLocation(citation)} (end position exclusive)${citation.source ? ` [${citation.source}]` : ""}${citation.unsaved ? " [unsaved editor contents]" : ""}`,
		`${fence}${language}\n${citation.code}${citation.code.endsWith("\n") ? "" : "\n"}${fence}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

export function gitCitationSource(query: string): {
	file: string;
	source: string;
} {
	const value = JSON.parse(query);
	if (
		typeof value.path !== "string" ||
		typeof value.ref !== "string" ||
		value.submoduleOf
	)
		throw new Error("This Git view is not a source file citation.");
	const source =
		value.ref === "" || value.ref === ":0"
			? "Git index (staged)"
			: value.ref === "~"
				? "Git comparison base (index or HEAD)"
				: `Git revision ${value.ref}`;
	return { file: value.path, source };
}
