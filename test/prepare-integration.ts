import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fixture } from "./fixture";

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

export async function prepare() {
	const f = await fixture();
	const { worktree } = await f.service.create("PLAN-integration");
	const events = path.join(f.root, "events");
	const bin = path.join(f.root, "bin");
	await fs.mkdir(events);
	await fs.mkdir(bin);
	await fs.writeFile(
		path.join(f.root, "bashrc"),
		"export WORKY_TEST_INTERACTIVE=yes\n",
	);
	const shell = path.join(f.root, "test-bash");
	await fs.writeFile(
		shell,
		`#!/bin/bash\nexport PATH=${quote(bin)}:"$PATH"\nexec /bin/bash --noprofile --rcfile ${quote(path.join(f.root, "bashrc"))} "$@"\n`,
		{ mode: 0o755 },
	);
	await fs.writeFile(
		path.join(bin, "pnpm"),
		`#!/bin/bash
set -eu
test "$#" = 2 && test "$1" = run && test "$2" = setup || exit 91
app="$(basename "$PWD")"
case "$app" in web) peer=api;; api) peer=web;; *) exit 92;; esac
events=${quote(events)}
test "\${WORKY_TEST_INTERACTIVE:-}" = yes || exit 94
printf '%s\\n' "$PWD" >> "$events/$app.calls"
touch "$events/$app.started"
while test -f "$events/$app.hold"; do sleep 0.1; done
if test -f "$events/$app.fail"; then exit 17; fi
# If setup were sequential, this would time out. Neither command runs real pnpm or Docker.
for i in {1..100}; do
  if test -f "$events/$peer.started"; then
    echo "$app fixture setup complete"
    exit 0
  fi
  sleep 0.1
done
exit 93
`,
		{ mode: 0o755 },
	);
	const data = {
		root: f.root,
		repository: f.repository,
		worktree: worktree.path,
		events,
		shell,
		worktreesPath: f.service.config.worktreesPath,
	};
	await fs.writeFile(path.join(f.root, "fixture.json"), JSON.stringify(data));
	return data;
}
