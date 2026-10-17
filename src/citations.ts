import * as vscode from "vscode";
import { Notifications } from "./notifications";
import * as path from "node:path";
import { CodeCitation, citationLocation, gitCitationSource } from "./citation";
import { CitationFiles } from "./citation-files";
import { CitationStore, SavedCitation } from "./citation-store";
import {
	T3CitationRequest,
	T3Target,
	T3CitationChoices,
	T3CitationSelection,
} from "./t3";
import { message, Worktree } from "./model";
import { canonicalPath } from "./paths";

export interface CitationDestination {
	worktree: Worktree;
	store: CitationStore;
	choices(): Promise<T3CitationChoices>;
	send(
		request: T3CitationRequest,
		checkpoint: () => Promise<void>,
	): Promise<{ target: T3Target; delivery: "queued" | "started" | "sent" }>;
}
export interface CitationRow extends SavedCitation {
	worktreePath: string;
}

interface DestinationRow {
	kind: "destination";
	label: string;
	locked: boolean;
}
interface NoticeRow {
	kind: "notice";
	label: string;
}
type Row = CitationRow | DestinationRow | NoticeRow;

export class Citations
	implements vscode.TreeDataProvider<Row>, vscode.Disposable
{
	private readonly files: CitationFiles;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly view: vscode.TreeView<Row>;
	private watcher?: vscode.FileSystemWatcher;
	private watched?: string;
	private revision = 0;
	private rows: CitationRow[] = [];
	private busy = false;
	private destinationRow?: DestinationRow;
	private noticeRow?: NoticeRow;
	private readonly choiceCache = new Map<
		string,
		{
			time: number;
			choices?: T3CitationChoices;
			error?: string;
			loading?: Promise<T3CitationChoices>;
		}
	>();

	constructor(
		private readonly resolve: (
			file: string,
		) => Promise<CitationDestination>,
		private readonly current: () => CitationDestination | undefined,
		private readonly notifications: Notifications,
	) {
		this.files = new CitationFiles((worktreePath) => {
			const destination = this.current();
			if (!destination || destination.worktree.path !== worktreePath)
				throw new Error("Open the citation's worktree first.");
			return destination.store;
		});
		this.view = vscode.window.createTreeView("worky.citations", {
			treeDataProvider: this,
		});
	}

	getCitations(): CitationRow[] {
		return this.rows;
	}
	getChildren(): Row[] {
		return [
			...(this.destinationRow ? [this.destinationRow] : []),
			...(this.noticeRow ? [this.noticeRow] : []),
			...this.rows,
		];
	}
	getTreeItem(row: Row): vscode.TreeItem {
		if ("kind" in row && row.kind === "notice") {
			const item = new vscode.TreeItem(row.label);
			item.id = "citation-notice";
			item.tooltip = row.label;
			item.iconPath = new vscode.ThemeIcon("info");
			return item;
		}
		if ("kind" in row) {
			const item = new vscode.TreeItem(`Send to: ${row.label}`);
			item.id = "citation-destination";
			item.iconPath = new vscode.ThemeIcon("comment-discussion");
			item.description = row.locked ? "retry destination" : "Change…";
			item.tooltip = row.locked
				? "Retry uses the original destination. Clear the pending batch before changing it."
				: "Choose a thread or create a new thread when sending.";
			if (!row.locked)
				item.command = {
					command: "worky.selectCitationThread",
					title: "Select Destination Thread",
				};
			return item;
		}
		const item = new vscode.TreeItem(
			`${row.citation.file}:${row.citation.startLine}`,
		);
		item.id = `${row.worktreePath}:${row.id}`;
		item.description = row.comment || "No comment";
		item.tooltip = `${citationLocation(row.citation)}\n${row.comment}`;
		item.iconPath = new vscode.ThemeIcon("quote");
		item.contextValue = "citation";
		item.command = {
			command: "worky.previewCitation",
			title: "Edit Citation",
			arguments: [row],
		};
		return item;
	}

	async refresh(): Promise<void> {
		const revision = ++this.revision;
		const destination = this.current();
		const directory = destination?.store.state.directory;
		if (directory !== this.watched) {
			this.watcher?.dispose();
			this.watched = directory;
			if (directory) {
				this.watcher = vscode.workspace.createFileSystemWatcher(
					new vscode.RelativePattern(directory, "*.citations.json"),
				);
				const update = () =>
					void this.refresh().catch((error) => {
						this.notifications.show(
							`Worky: ${message(error)}`,
							"error",
						);
					});
				this.watcher.onDidCreate(update);
				this.watcher.onDidChange(update);
				this.watcher.onDidDelete(update);
			}
		}
		const batch = await destination?.store.read();
		if (revision !== this.revision) return;
		this.rows = (batch?.items ?? []).map((item) => ({
			...item,
			worktreePath: destination!.worktree.path,
		}));
		const cached = destination
			? this.choiceCache.get(destination.worktree.path)
			: undefined;
		const pinned = batch?.pending?.request;
		const selection =
			pinned?.selection ??
			batch?.selection ??
			this.defaultSelection(cached?.choices);
		this.destinationRow = destination
			? {
					kind: "destination",
					label: pinned?.target
						? (selection?.title ?? pinned.target.threadId)
						: (selection?.title ??
							(cached?.error
								? "T3 unavailable — select thread"
								: "Loading most recent thread…")),
					locked: !!batch?.pending,
				}
			: undefined;
		if (
			destination &&
			(!cached || Date.now() - cached.time > 30_000) &&
			!cached?.loading
		)
			void this.loadChoices(destination)
				.then(
					() => this.refresh(),
					() => this.refresh(),
				)
				.catch(() => {});
		this.view.title = `Citations (${this.rows.length})`;
		this.view.description = destination
			? (destination.worktree.branch ??
				path.basename(destination.worktree.path))
			: undefined;
		const notice = batch?.pending
			? "Delivery uncertain — retry the saved batch before sending more."
			: !this.rows.length
				? "Select code, then right-click → Cite to T3 or press Ctrl+Shift+C."
				: undefined;
		this.noticeRow = notice ? { kind: "notice", label: notice } : undefined;
		// View messages appear above every tree row. Keep hints below the selector.
		this.view.message = undefined;
		await vscode.commands.executeCommand(
			"setContext",
			"worky.cite.hasItems",
			this.rows.length > 0,
		);
		await vscode.commands.executeCommand(
			"setContext",
			"worky.cite.canRetry",
			!!batch?.pending,
		);
		this.files.refresh();
		this.changed.fire();
	}

	private defaultSelection(
		choices?: T3CitationChoices,
	): T3CitationSelection | undefined {
		if (!choices) return undefined;
		const thread = choices.threads[0];
		return {
			kind: thread ? "thread" : "new",
			threadId: thread?.id,
			title: thread ? thread.title || thread.id : "New thread",
			origin: choices.origin,
			environmentId: choices.environmentId,
		};
	}

	private async loadChoices(
		destination: CitationDestination,
		force = false,
	): Promise<T3CitationChoices> {
		const key = destination.worktree.path;
		const cached = this.choiceCache.get(key);
		if (cached?.loading) return cached.loading;
		if (!force && cached?.choices && Date.now() - cached.time < 30_000)
			return cached.choices;
		const entry = {
			time: Date.now(),
			choices: cached?.choices,
			loading: undefined as Promise<T3CitationChoices> | undefined,
			error: undefined as string | undefined,
		};
		this.choiceCache.set(key, entry);
		entry.loading = Promise.resolve()
			.then(() => destination.choices())
			.then((choices) => {
				entry.choices = choices;
				return choices;
			})
			.catch((error) => {
				entry.choices = undefined;
				entry.error = message(error);
				throw error;
			})
			.finally(() => {
				entry.loading = undefined;
			});
		return entry.loading;
	}

	private pickThread(
		items: (vscode.QuickPickItem & { selection: T3CitationSelection })[],
	): Thenable<
		(vscode.QuickPickItem & { selection: T3CitationSelection }) | undefined
	> {
		return new Promise((resolve) => {
			const picker =
				vscode.window.createQuickPick<(typeof items)[number]>();
			picker.title = "Citation destination";
			picker.placeholder =
				"Choose a thread for this worktree, or New thread";
			picker.matchOnDescription = true;
			picker.items = items;
			picker.activeItems = [
				items.find((item) => item.picked) ?? items[0]!,
			];
			const subscriptions: vscode.Disposable[] = [];
			let done = false;
			const finish = (item?: (typeof items)[number]) => {
				if (done) return;
				done = true;
				subscriptions.forEach((subscription) => subscription.dispose());
				picker.dispose();
				resolve(item);
			};
			subscriptions.push(
				picker.onDidAccept(() => finish(picker.selectedItems[0])),
				picker.onDidHide(() => finish()),
			);
			picker.show();
		});
	}

	async selectThread(): Promise<void> {
		if (this.busy) return;
		const destination = this.destination();
		const batch = await destination.store.read();
		if (batch.pending)
			throw new Error(
				"Retry or clear the pending batch before changing its destination.",
			);
		const choices = await this.loadChoices(destination, true);
		const selected = batch.selection ?? this.defaultSelection(choices);
		const items = choices.threads.map((thread, index) => ({
			label: thread.title || thread.id,
			description: `${index === 0 ? "Most recent · " : ""}${thread.id.slice(0, 8)}`,
			picked:
				selected?.kind === "thread" && selected.threadId === thread.id,
			selection: {
				kind: "thread" as const,
				threadId: thread.id,
				title: thread.title || thread.id,
				origin: choices.origin,
				environmentId: choices.environmentId,
			},
		}));
		const choice = await this.pickThread([
			...items,
			{
				label: "$(add) New thread",
				description: "Created only when you send",
				picked: selected?.kind === "new",
				selection: {
					kind: "new",
					title: "New thread",
					origin: choices.origin,
					environmentId: choices.environmentId,
				},
			},
		]);
		if (choice) await destination.store.select(choice.selection);
		await this.refresh();
	}

	private destination(row?: CitationRow): CitationDestination {
		const destination = this.current();
		if (
			!destination ||
			(row && row.worktreePath !== destination.worktree.path)
		)
			throw new Error("Open the citation's worktree first.");
		return destination;
	}

	async cite(uri?: vscode.Uri): Promise<void> {
		if (this.busy) return;
		const editor = vscode.window.activeTextEditor;
		if (
			!editor ||
			!vscode.workspace.isTrusted ||
			!["file", "vscode-remote", "git"].includes(
				editor.document.uri.scheme,
			)
		)
			throw new Error("Select code in a trusted Git workspace first.");
		if (uri && uri.toString() !== editor.document.uri.toString())
			throw new Error("Select code in the active editor first.");
		const selection = editor.selection;
		if (selection.isEmpty) throw new Error("Select code to cite first.");
		const source =
			editor.document.uri.scheme === "git"
				? gitCitationSource(editor.document.uri.query)
				: { file: editor.document.uri.fsPath, source: undefined };
		if (!path.isAbsolute(source.file))
			throw new Error("The source file path is invalid.");
		const citation: CodeCitation = {
			file: source.file,
			source: source.source,
			startLine: selection.start.line + 1,
			startColumn: selection.start.character + 1,
			endLine: selection.end.line + 1,
			endColumn: selection.end.character + 1,
			language: editor.document.languageId,
			code: editor.document.getText(selection),
			unsaved: editor.document.isDirty,
		};
		this.busy = true;
		try {
			const destination = await this.resolve(citation.file);
			if (destination.worktree.path !== this.destination().worktree.path)
				throw new Error(
					"Open this file's worktree before collecting citations.",
				);
			// Resolve directory aliases (including /var on macOS), while keeping
			// a tracked symlink's own leaf name as the cited repository path.
			const sourceFile = path.join(
				await canonicalPath(path.dirname(citation.file)),
				path.basename(citation.file),
			);
			const relative = path.relative(
				destination.worktree.path,
				sourceFile,
			);
			if (
				relative === ".." ||
				relative.startsWith(`..${path.sep}`) ||
				path.isAbsolute(relative)
			)
				throw new Error("The selected file is outside this worktree.");
			citation.file = relative.split(path.sep).join("/");
			const comment = await this.askComment(citation);
			if (comment !== undefined)
				await destination.store.add(citation, comment);
		} finally {
			this.busy = false;
			await this.refresh();
		}
	}

	private askComment(
		citation: CodeCitation,
		value = "",
	): Thenable<string | undefined> {
		return vscode.window.showInputBox({
			title: "Add Citation to Batch",
			prompt: `${citationLocation(citation)} · Enter to save; Escape to cancel`,
			placeHolder: "Optional comment",
			value,
			ignoreFocusOut: true,
		});
	}
	private askInstruction(
		count: number,
		target?: string,
	): Thenable<string | undefined> {
		return vscode.window.showInputBox({
			title: `Send ${count} Citations to ${target ?? "T3"}`,
			prompt: "Enter to send the entire batch as one message; Escape to cancel",
			placeHolder: "Optional overall instruction",
			ignoreFocusOut: true,
		});
	}

	async preview(row: CitationRow): Promise<void> {
		const item = (await this.destination(row).store.read()).items.find(
			(item) => item.id === row.id,
		);
		if (!item) throw new Error("This citation was already removed.");
		const uri = this.files.uri(row.worktreePath, item);
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: false });
	}
	async edit(row: CitationRow): Promise<void> {
		await this.preview(row);
	}

	async remove(row: CitationRow): Promise<void> {
		await this.destination(row).store.remove(row.id);
		await this.refresh();
	}
	async clear(): Promise<void> {
		const destination = this.destination();
		const batch = await destination.store.read();
		if (!batch.items.length) return;
		const action = await vscode.window.showWarningMessage(
			batch.pending
				? "Clear this batch and discard its retry? T3 may already have received the pending message."
				: `Clear all ${batch.items.length} collected citations?`,
			{ modal: true },
			"Clear All",
		);
		if (action === "Clear All") await destination.store.clear(batch);
		await this.refresh();
	}

	async send(retry = false): Promise<void> {
		if (this.busy) return;
		const destination = this.destination();
		this.busy = true;
		try {
			const saveDrafts = async () => {
				for (const document of vscode.workspace.textDocuments) {
					if (
						document.isDirty &&
						this.files.belongsTo(
							document.uri,
							destination.worktree.path,
						) &&
						!(await document.save())
					)
						throw new Error(
							"Save your citation edits before sending the batch.",
						);
				}
			};
			if (!retry) await saveDrafts();
			const batch = await destination.store.read();
			if (retry && !batch.pending) return;
			if (!retry && batch.pending)
				throw new Error(
					"Use Retry Citation Batch to finish the previous send first.",
				);
			if (!batch.items.length) return;
			let selection = batch.pending?.request.selection;
			if (!retry) {
				const choices = await this.loadChoices(destination, true);
				selection = batch.selection ?? this.defaultSelection(choices);
				if (
					!selection ||
					selection.origin !== choices.origin ||
					selection.environmentId !== choices.environmentId ||
					(selection.kind === "thread" &&
						!choices.threads.some(
							(thread) => thread.id === selection!.threadId,
						))
				)
					throw new Error(
						"The selected thread is unavailable. Choose a destination again.",
					);
			}
			const instruction = retry
				? ""
				: await this.askInstruction(
						batch.items.length,
						selection?.title,
					);
			if (instruction === undefined) return;
			// The prompt can stay open while the user edits a citation. Save those
			// edits, but require a fresh send decision if the reviewed batch changed.
			if (!retry) await saveDrafts();
			const sent = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Worky: sending citation batch to T3",
				},
				() =>
					destination.store.send(
						retry ? undefined : batch.items,
						instruction,
						async (request, checkpoint) => {
							// Publish the pending read-only state immediately, rather than
							// waiting for the filesystem watcher during network dispatch.
							await this.refresh();
							return destination.send(request, checkpoint);
						},
						selection,
					),
			);
			if (sent)
				this.notifications.show(
					`Worky: ${sent.count} citations ${sent.result.delivery === "queued" ? "queued" : "sent"} in one T3 message.`,
					"info",
					{
						command: "vscode.open",
						title: "Open Chat",
						arguments: [vscode.Uri.parse(sent.result.target.url)],
					},
				);
		} catch (error) {
			const pending = await destination.store.read().then(
				(batch) => !!batch.pending,
				() => false,
			);
			this.notifications.show(
				`Worky: ${message(error)} Your citations are retained.`,
				"error",
				pending
					? { command: "worky.retryCitation", title: "Retry Batch" }
					: {
							command: "worky.sendCitations",
							title: "Send All Citations",
						},
			);
		} finally {
			this.busy = false;
			await this.refresh();
		}
	}

	dispose(): void {
		this.files.dispose();
		this.watcher?.dispose();
		this.view.dispose();
		this.changed.dispose();
	}
}
