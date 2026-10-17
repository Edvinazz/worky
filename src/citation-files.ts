import * as vscode from "vscode";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { CitationStore, SavedCitation } from "./citation-store";

// Editable Markdown documents backed by the same durable batch as the sidebar.
export class CitationFiles
	implements vscode.FileSystemProvider, vscode.Disposable
{
	private readonly changed = new vscode.EventEmitter<
		vscode.FileChangeEvent[]
	>();
	readonly onDidChangeFile = this.changed.event;
	private readonly baselines = new Map<string, string>();
	private readonly versions = new Map<
		string,
		{ hash: string; time: number }
	>();
	private readonly registration: vscode.Disposable;
	private readonly closed: vscode.Disposable;
	constructor(
		private readonly resolve: (worktreePath: string) => CitationStore,
	) {
		this.registration = vscode.workspace.registerFileSystemProvider(
			"worky-citation",
			this,
			{ isCaseSensitive: true },
		);
		this.closed = vscode.workspace.onDidCloseTextDocument((document) => {
			if (document.uri.scheme !== "worky-citation" || document.isDirty)
				return;
			this.baselines.delete(document.uri.toString());
			this.versions.delete(document.uri.toString());
		});
	}

	uri(worktreePath: string, item: SavedCitation): vscode.Uri {
		return vscode.Uri.from({
			scheme: "worky-citation",
			path: `/${item.id}/${path.basename(item.citation.file)}.md`,
			query: JSON.stringify({ worktreePath }),
		});
	}
	private target(uri: vscode.Uri): { store: CitationStore; id: string } {
		try {
			const { worktreePath } = JSON.parse(uri.query);
			const id = uri.path.split("/")[1];
			if (typeof worktreePath !== "string" || !id) throw new Error();
			return { store: this.resolve(worktreePath), id };
		} catch {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
	}
	belongsTo(uri: vscode.Uri, worktreePath: string): boolean {
		if (uri.scheme !== "worky-citation") return false;
		try {
			return JSON.parse(uri.query).worktreePath === worktreePath;
		} catch {
			return false;
		}
	}
	private async entry(uri: vscode.Uri) {
		const { store, id } = this.target(uri);
		const batch = await store.read();
		const item =
			batch.items.find((item) => item.id === id) ??
			batch.sentDrafts?.find((item) => item.id === id);
		if (!item) throw vscode.FileSystemError.FileNotFound(uri);
		return { store, item, pending: !!batch.pending?.ids.includes(id) };
	}
	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const { item, pending } = await this.entry(uri);
		const hash = createHash("sha256")
			.update(item.markdown)
			.update(String(pending))
			.digest("hex");
		let version = this.versions.get(uri.toString());
		if (version?.hash !== hash) {
			version = {
				hash,
				time: Math.max(Date.now(), (version?.time ?? 0) + 1),
			};
			this.versions.set(uri.toString(), version);
		}
		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: version!.time,
			size: Buffer.byteLength(item.markdown),
			permissions: pending ? vscode.FilePermission.Readonly : undefined,
		};
	}
	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const { item } = await this.entry(uri);
		// A background read must not replace the base of an unsaved edit.
		if (
			!vscode.workspace.textDocuments.some(
				(doc) => doc.uri.toString() === uri.toString() && doc.isDirty,
			)
		)
			this.baselines.set(uri.toString(), item.markdown);
		return Buffer.from(item.markdown, "utf8");
	}
	async writeFile(
		uri: vscode.Uri,
		content: Uint8Array,
		options: { create: boolean; overwrite: boolean },
	): Promise<void> {
		if (!options.overwrite) throw vscode.FileSystemError.FileExists(uri);
		const { store, item } = await this.entry(uri);
		let expected = this.baselines.get(uri.toString());
		if (expected === undefined) {
			// Hot-exit can restore a dirty document without a read of its original
			// base. Never assume today's stored text is the version the user edited.
			if (!(await this.confirmRestoredDraft()))
				throw vscode.FileSystemError.Unavailable(
					"The restored draft was not saved.",
				);
			expected = item.markdown;
		}
		const markdown = Buffer.from(content).toString("utf8");
		await store.editMarkdown(item.id, markdown, expected);
		this.baselines.set(uri.toString(), markdown);
		this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}
	private async confirmRestoredDraft(): Promise<boolean> {
		return (
			(await vscode.window.showWarningMessage(
				"This citation draft was restored without its original saved version. Replace the currently saved citation with your draft?",
				{ modal: true },
				"Save My Draft",
			)) === "Save My Draft"
		);
	}
	refresh(): void {
		const events = vscode.workspace.textDocuments
			.filter((doc) => doc.uri.scheme === "worky-citation")
			.map((doc) => ({
				type: vscode.FileChangeType.Changed,
				uri: doc.uri,
			}));
		if (events.length) this.changed.fire(events);
	}
	watch(): vscode.Disposable {
		return new vscode.Disposable(() => {});
	}
	readDirectory(): [string, vscode.FileType][] {
		return [];
	}
	createDirectory(): void {
		throw vscode.FileSystemError.NoPermissions(
			"Use Cite to T3 to add a citation.",
		);
	}
	delete(): void {
		throw vscode.FileSystemError.NoPermissions(
			"Remove citations using the Citations sidebar.",
		);
	}
	rename(): void {
		throw vscode.FileSystemError.NoPermissions(
			"Citation names reflect their source file.",
		);
	}
	dispose(): void {
		this.registration.dispose();
		this.closed.dispose();
		this.changed.dispose();
		this.baselines.clear();
		this.versions.clear();
	}
}
