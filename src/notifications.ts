import * as vscode from "vscode";

/** One transient notice; full messages remain available in the Worky log. */
export class Notifications implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem(
		"worky.notice",
		vscode.StatusBarAlignment.Left,
		100,
	);
	private timer?: ReturnType<typeof setTimeout>;

	constructor(private readonly log: (line: string) => void) {
		this.item.name = "Worky notifications";
	}

	show(
		text: string,
		severity: "info" | "warning" | "error" = "info",
		action?: vscode.Command,
	): void {
		this.log(`[${severity}] ${text}`);
		clearTimeout(this.timer);
		const compact = text.replace(/\s+/g, " ").replace(/\$\(/g, "$ (");
		this.item.text = `$(${severity === "info" ? "info" : severity}) ${compact.length > 100 ? compact.slice(0, 99) + "…" : compact}`;
		this.item.tooltip = `${text}\n\n${action?.title ?? "Show Worky Log"}`;
		this.item.command = action ?? "worky.showLog";
		this.item.show();
		this.timer = setTimeout(
			() => this.item.hide(),
			severity === "info" ? 5_000 : 10_000,
		);
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.item.dispose();
	}
}
