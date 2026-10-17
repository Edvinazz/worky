import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CodeCitation, formatCitation } from "./citation";
import { StateStore } from "./state";
import {
	createCitationRequest,
	T3CitationRequest,
	T3CitationSelection,
} from "./t3";

export interface SavedCitation {
	id: string;
	citation: CodeCitation;
	comment: string;
	markdown: string;
}
export interface CitationBatch {
	version: 1;
	path: string;
	items: SavedCitation[];
	// Acknowledged snapshots back editors that may still be open in any window.
	// Saving a changed snapshot queues a draft; it never changes the sent request.
	sentDrafts?: SavedCitation[];
	selection?: T3CitationSelection;
	pending?: { ids: string[]; request: T3CitationRequest };
}

export function formatBatch(
	items: SavedCitation[],
	instruction: string,
): string {
	return [
		instruction.trim(),
		...items.map(
			(item, index) => `## Citation ${index + 1}\n\n${item.markdown}`,
		),
	]
		.filter(Boolean)
		.join("\n\n");
}

export class CitationStore {
	readonly filename: string;
	constructor(
		readonly state: StateStore,
		readonly worktreePath: string,
	) {
		this.filename = path.join(
			state.directory,
			`${createHash("sha256").update(worktreePath).digest("hex")}.citations.json`,
		);
	}

	async read(): Promise<CitationBatch> {
		try {
			const batch = JSON.parse(
				await fs.readFile(this.filename, "utf8"),
			) as CitationBatch;
			if (
				batch.version !== 1 ||
				batch.path !== this.worktreePath ||
				!Array.isArray(batch.items) ||
				!batch.items.every(
					(item) =>
						typeof item.id === "string" &&
						typeof item.markdown === "string" &&
						typeof item.comment === "string" &&
						typeof item.citation?.code === "string",
				) ||
				(batch.sentDrafts !== undefined &&
					(!Array.isArray(batch.sentDrafts) ||
						!batch.sentDrafts.every(
							(item) =>
								item &&
								typeof item.id === "string" &&
								typeof item.markdown === "string" &&
								typeof item.comment === "string" &&
								typeof item.citation?.code === "string",
						))) ||
				(batch.pending &&
					(!Array.isArray(batch.pending.ids) ||
						typeof batch.pending.request?.text !== "string" ||
						typeof batch.pending.request.commandId !== "string" ||
						typeof batch.pending.request.messageId !== "string"))
			)
				throw new Error("Unexpected citation batch format.");
			return batch;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { version: 1, path: this.worktreePath, items: [] };
			throw error;
		}
	}

	private async save(batch: CitationBatch): Promise<void> {
		await fs.mkdir(this.state.directory, { recursive: true });
		const temp = `${this.filename}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temp, JSON.stringify(batch, null, 2) + "\n", {
				mode: 0o600,
			});
			await fs.rename(temp, this.filename);
		} finally {
			await fs.rm(temp, { force: true });
		}
	}

	private async change(
		action: (batch: CitationBatch) => void,
	): Promise<void> {
		await this.state.withLock(
			`citations:${this.worktreePath}`,
			async () => {
				const batch = await this.read();
				action(batch);
				await this.save(batch);
			},
		);
	}

	async add(citation: CodeCitation, comment: string): Promise<void> {
		await this.change((batch) =>
			batch.items.push({
				id: randomUUID(),
				citation,
				comment,
				markdown: formatCitation(citation, comment),
			}),
		);
	}

	async select(selection: T3CitationSelection): Promise<void> {
		await this.change((batch) => {
			if (batch.pending)
				throw new Error(
					"Retry or clear the pending batch before changing its destination.",
				);
			batch.selection = selection;
		});
	}

	async editMarkdown(
		id: string,
		markdown: string,
		expected: string,
	): Promise<void> {
		await this.change((batch) => {
			this.editable(batch, id);
			let item = batch.items.find((item) => item.id === id);
			const sent =
				!item && batch.sentDrafts?.find((item) => item.id === id);
			item ??= sent || undefined;
			if (!item) throw new Error("This citation was already removed.");
			if (item.markdown !== expected && item.markdown !== markdown)
				throw new Error(
					"This citation changed in another window. Reopen it to review the saved version before saving your changes.",
				);
			if (sent) {
				if (markdown === sent.markdown) return;
				batch.items.push(item);
				batch.sentDrafts = batch.sentDrafts!.filter(
					(item) => item.id !== id,
				);
			}
			item.markdown = markdown;
			item.comment =
				markdown
					.split("\n")
					.find((line) => line.trim())
					?.trim() ?? "";
		});
	}

	async remove(id: string): Promise<void> {
		await this.change((batch) => {
			this.editable(batch, id);
			batch.items = batch.items.filter((item) => item.id !== id);
		});
	}

	private editable(batch: CitationBatch, id: string): void {
		if (batch.pending?.ids.includes(id))
			throw new Error(
				"This citation belongs to a batch with uncertain delivery. Retry the batch, or clear it before editing.",
			);
	}

	async clear(expected: CitationBatch): Promise<void> {
		await this.change((batch) => {
			if (JSON.stringify(batch) !== JSON.stringify(expected))
				throw new Error(
					"The batch changed in another window. Review it before clearing.",
				);
			batch.items = [];
			delete batch.pending;
		});
	}

	async send<T>(
		expected: SavedCitation[] | undefined,
		instruction: string,
		deliver: (
			request: T3CitationRequest,
			checkpoint: () => Promise<void>,
		) => Promise<T>,
		selection?: T3CitationSelection,
	): Promise<{ result: T; count: number } | undefined> {
		return this.state.withLock(
			`citations:${this.worktreePath}`,
			async () => {
				const batch = await this.read();
				if (!batch.pending) {
					// No expected items means retry only, never silently send a fresh batch.
					if (!expected || !batch.items.length) return undefined;
					if (
						JSON.stringify(expected) !== JSON.stringify(batch.items)
					)
						throw new Error(
							"The batch changed in another window. Review it and send again.",
						);
					batch.pending = {
						ids: batch.items.map((item) => item.id),
						request: {
							...createCitationRequest(
								formatBatch(batch.items, instruction),
							),
							...(selection ? { selection } : {}),
						},
					};
					await this.save(batch);
				} else if (expected) {
					throw new Error(
						"A previous batch has uncertain delivery. Use Retry Citation Batch first.",
					);
				}
				const pending = batch.pending;
				// Persist the resolved destination before T3 creates a thread or sends a message.
				const result = await deliver(pending.request, () =>
					this.save(batch),
				);
				const retained = batch.items.filter((item) =>
					pending.ids.includes(item.id),
				);
				if (retained.length)
					batch.sentDrafts = [
						...(batch.sentDrafts ?? []),
						...retained,
					];
				batch.items = batch.items.filter(
					(item) => !pending.ids.includes(item.id),
				);
				delete batch.pending;
				await this.save(batch);
				return { result, count: pending.ids.length };
			},
		);
	}
}
