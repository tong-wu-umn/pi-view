import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { QuickOpen } from "../src/quick-open.ts";

initTheme("dark", false);
const theme = getThemeByName("dark")!;

async function fixture(t: { after(fn: () => void | Promise<void>): void }, count: number | string[] = 0) {
  const dir = await mkdtemp(join(tmpdir(), "pi-view-quick-"));
  const recent: string[] = [];
  const names = Array.isArray(count) ? count : Array.from({ length: count }, (_, i) => `recent-${String(i).padStart(2, "0")}.txt`);
  for (const name of names) {
    const path = join(dir, name);
    await writeFile(path, "content"); recent.unshift(path);
  }
  const result: (string | undefined)[] = [];
  const tui = { terminal: { rows: 24, columns: 80, write() {} }, requestRender() {}, addInputListener: () => () => {} } as unknown as TUI;
  const quick = new QuickOpen(tui, theme, dir, Promise.resolve(recent), path => result.push(path));
  quick.focused = true;
  t.after(async () => { quick.dispose(); await rm(dir, { recursive: true, force: true }); });
  await delay(0);
  return { dir, quick, result };
}

function type(quick: QuickOpen, value: string): void {
  for (const character of value) quick.handleInput(character);
}

function screen(quick: QuickOpen): string {
  return stripTerminalSequences(quick.render(80).join("\n"));
}

async function selected(result: (string | undefined)[]): Promise<void> {
  for (let i = 0; i < 100 && !result.length; i++) await delay(10);
  assert.equal(result.length, 1);
}

test("Empty Quick Open shows newest twenty with a five-row scrolling viewport", async t => {
  const { dir, quick, result } = await fixture(t, 20);
  const initial = screen(quick);
  assert.match(initial, /recent-19/); assert.match(initial, /recent-15/);
  assert.doesNotMatch(initial, /recent-14/);
  assert.match(initial, /1\/20/);
  for (let i = 0; i < 5; i++) quick.handleInput("\x1b[B");
  assert.match(screen(quick), /recent-14/);
  assert.doesNotMatch(screen(quick), /recent-19/);
  quick.handleInput("\r"); await selected(result);
  assert.equal(result[0], join(dir, "recent-14.txt"));
});

test("Typing produces matching paths; Tab descends directories and arrows choose files", async t => {
  const { dir, quick, result } = await fixture(t);
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub/file-1.png"), "fixture");
  await writeFile(join(dir, "sub/file-2.md"), "fixture");
  type(quick, "su"); quick.handleInput("\t");
  assert.match(screen(quick), /> sub\//);
  type(quick, "f");
  assert.match(screen(quick), /file-1.png/); assert.match(screen(quick), /file-2.md/);
  quick.handleInput("\x1b[B"); quick.handleInput("\x1b[B"); quick.handleInput("\r");
  await selected(result);
  assert.equal(result[0], join(dir, "sub/file-2.md"));
});

test("Quick Open matches mixed-case paths and opens the original spelling", async t => {
  const { dir, quick, result } = await fixture(t);
  await mkdir(join(dir, "My Docs"));
  const path = join(dir, "My Docs", "Résumé.MD");
  await writeFile(path, "fixture");
  await writeFile(join(dir, "My Docs", "other.txt"), "fixture");

  type(quick, "mY d");
  assert.match(screen(quick), /My Docs\//);
  quick.handleInput("\t");
  type(quick, "rÉ");
  assert.match(screen(quick), /Résumé\.MD/);
  assert.doesNotMatch(screen(quick), /other\.txt/);
  quick.handleInput("\x1b[B");
  quick.handleInput("\r");
  await selected(result);
  assert.deepEqual(result, [path]);
});

test("Enter opens typed relative and absolute paths, including spaces", async t => {
  for (const absolute of [false, true]) {
    const { dir, quick, result } = await fixture(t);
    const path = join(dir, "file with spaces.txt");
    await writeFile(path, "fixture");
    type(quick, absolute ? path : "file with spaces.txt");
    quick.handleInput("\r"); await selected(result);
    assert.equal(result[0], path);
  }
});

test("Home-relative input resolves through the same path completer", async t => {
  const { dir, quick, result } = await fixture(t);
  const previousHome = process.env.HOME;
  const previousUserprofile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir; // Windows: os.homedir() reads USERPROFILE, not HOME
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserprofile;
  });
  await writeFile(join(dir, "home.txt"), "fixture");
  type(quick, "~/ho"); quick.handleInput("\t");
  quick.handleInput("\r"); await selected(result);
  assert.equal(result[0], join(dir, "home.txt"));
});

test("Escape clears typed input first and closes only when empty", async t => {
  const { quick, result } = await fixture(t, 2);
  type(quick, "does-not-exist");
  assert.match(screen(quick), /does-not-exist/);
  quick.handleInput("\x1b");
  assert.equal(result.length, 0);
  assert.doesNotMatch(screen(quick), /does-not-exist/);
  assert.match(screen(quick), /Recent files/);
  for (const width of [1, 8, 40]) for (const line of quick.render(width)) assert.ok(visibleWidth(line) <= width);
  quick.handleInput("\x1b");
  assert.deepEqual(result, [undefined]);
});

test("Tab on a recent flag-like or literal-tilde name preserves the selected file", async t => {
  for (const name of ["-note.txt", "~"]) {
    const { dir, quick, result } = await fixture(t, [name]);
    quick.handleInput("\t");
    quick.handleInput("\r");
    await selected(result);
    assert.deepEqual(result, [join(dir, name)]);
  }
});

test("Entering a quoted flag-like directory keeps subsequent completion inside it", async t => {
  const { dir, quick, result } = await fixture(t);
  await mkdir(join(dir, "-folder"));
  await writeFile(join(dir, "-folder", "child.txt"), "content");
  type(quick, '"-folder"');
  quick.handleInput("\r");
  for (let i = 0; i < 100 && !screen(quick).includes("child.txt"); i++) await delay(10);
  assert.match(screen(quick), /child\.txt/);
  quick.handleInput("\t"); quick.handleInput("\r");
  await selected(result);
  assert.deepEqual(result, [join(dir, "-folder", "child.txt")]);
});

test("Restoring a picker keeps the query and selects the file it came back from", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-view-quick-restore-"));
  const alpha = join(dir, "alpha.txt"); const beta = join(dir, "beta.txt");
  await writeFile(alpha, "a"); await writeFile(beta, "b");
  const tui = { terminal: { rows: 24, columns: 80, write() {} }, requestRender() {}, addInputListener: () => () => {} } as unknown as TUI;
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  // A typed query normally leaves nothing selected, so Enter would open the
  // literal text; the restore path must win and reopen the same file.
  const typed: (string | undefined)[] = [];
  const afterQuery = new QuickOpen(tui, theme, dir, Promise.resolve([beta, alpha]), path => typed.push(path), { query: "al", path: alpha });
  t.after(() => afterQuery.dispose());
  assert.equal(afterQuery.query, "al");
  afterQuery.handleInput("\r");
  await selected(typed);
  assert.deepEqual(typed, [alpha]);
  // An empty query restores from recents, highlighting the returned file
  // instead of defaulting to the newest entry.
  const recents: (string | undefined)[] = [];
  const afterRecent = new QuickOpen(tui, theme, dir, Promise.resolve([beta, alpha]), path => recents.push(path), { query: "", path: alpha });
  t.after(() => afterRecent.dispose());
  await delay(0);
  afterRecent.handleInput("\r");
  await selected(recents);
  assert.deepEqual(recents, [alpha]);
});

test("A restore path that is gone falls back to ordinary picker behaviour", async t => {
  const { dir, quick, result } = await fixture(t, ["kept.txt"]);
  const missing = join(dir, "deleted.txt");
  const restored = new QuickOpen(
    { terminal: { rows: 24, columns: 80, write() {} }, requestRender() {}, addInputListener: () => () => {} } as unknown as TUI,
    theme, dir, Promise.resolve([join(dir, "kept.txt")]), path => result.push(path), { query: "", path: missing });
  t.after(() => restored.dispose());
  await delay(0);
  // No match for the missing file: Enter opens the newest recent instead.
  restored.handleInput("\r");
  await selected(result);
  assert.deepEqual(result, [join(dir, "kept.txt")]);
  assert.equal(quick.query, "");
});
