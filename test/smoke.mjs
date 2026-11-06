/**
 * Smoke test: verifies naming, migration, index, report and multi-frame zstd
 * decoding without starting DSH.
 *
 * Run: node test/smoke.mjs
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

import { DEFAULT_CONFIG, resolveConfig } from "../lib/config.js";
import { readIndex } from "../lib/index-store.js";
import { migrateRoot } from "../lib/migrate.js";
import { buildFolderName, slugify, uniqueFolderName } from "../lib/naming.js";
import { readSessionFile } from "../lib/zstd.js";

const base = await mkdtemp(path.join(os.tmpdir(), "cf-smoke-"));
const root = path.join(base, "ws");
const folderDir = path.join(root, "conversations");

const now = Date.now();
const call = (seq, name, args) => ({
  type: "tool/call",
  seq,
  time: now,
  data: { turn: 1, step: 1, callId: `call-${seq}`, name, arguments: JSON.stringify(args) }
});
const title = (seq, text) => ({ type: "session/title", seq, time: now, data: { title: text, source: { kind: "fallback" } } });
const session = (id, titleText, events) => ({
  header: { type: "session", version: 4, id, createdAt: now, cwd: root, delegationDepth: 0 },
  events: [title(0, titleText), ...events]
});

// ---------- naming ----------
assert.equal(slugify('  替换图片:透明/通道?  '), "替换图片_透明_通道");
assert.equal(slugify("a".repeat(60), 10).length, 10);
const name = buildFolderName({ createdAt: now, title: "测试标题", sessionId: "session-abcdef12-3456", maxSlugLength: 30 });
assert.match(name, /^\d{4}-\d{2}-\d{2}_测试标题__abcdef12$/);
assert.equal(uniqueFolderName(name, new Set([name.toLowerCase()])), `${name}_2`);

// ---------- simulated workspace ----------
await mkdir(path.join(root, "project-addon"), { recursive: true });
await writeFile(path.join(root, "project-addon", "Addon.cs"), "// addon");
await writeFile(path.join(root, "tool.py"), "print(1)");
await mkdir(path.join(root, "project-editor"), { recursive: true });
await writeFile(path.join(root, "project-editor", "Plugin.cs"), "// plugin");
await mkdir(path.join(root, "project-render"), { recursive: true });
await writeFile(path.join(root, "project-render", "render.cs"), "// render");
await mkdir(path.join(root, "notes"), { recursive: true });
await writeFile(path.join(root, "notes", "note.md"), "# note");
await writeFile(path.join(root, "history.db"), "db");

const ids = {
  addon: "session-00cca673-0000-4000-8000-000000000001",
  tool: "session-d80a37f3-0000-4000-8000-000000000002",
  render: "session-21e3a6df-0000-4000-8000-000000000003",
  child: "4cc830e0-0000-4000-8000-000000000004"
};
const sessions = [
  session(ids.addon, "构建插件脚手架", [
    call(1, "write", { file_path: path.join(root, "project-addon", "Addon.cs"), content: "x" })
  ]),
  session(ids.tool, "替换图片透明通道", [
    call(1, "write", { file_path: path.join(root, "tool.py"), content: "x" }),
    call(2, "edit", { file_path: "project-editor/Plugin.cs", old_string: "a", new_string: "b" })
  ]),
  session(ids.render, "渲染材质工具", [
    call(1, "write", { file_path: path.join(root, "project-render", "render.cs"), content: "x" }),
    call(2, "deliverables", {})
  ]),
  {
    // Subagent: strong evidence must roll up to the parent session (render).
    header: {
      type: "session",
      version: 4,
      id: ids.child,
      createdAt: now,
      cwd: root,
      parentSession: ids.render,
      origin: "subagent",
      delegationDepth: 1
    },
    events: [call(1, "write", { file_path: path.join(root, "notes", "note.md"), content: "x" })]
  }
];

// ---------- migration ----------
const config = resolveConfig({ ...DEFAULT_CONFIG });
let logged = [];
const first = await migrateRoot({ root, sessions, config, logger: (message) => logged.push(message) });
assert.equal(first.skipped, false, "first migration should run");
assert.equal(first.moved.length, 5, `expected 5 moved entries, got ${first.moved.length}: ${JSON.stringify(first.moved.map((m) => m.top))}`);
assert.equal(first.unattributed.length, 1, "history.db should be unattributed");
assert.equal(first.conflicts.length, 0, "there should be no conflicts");

const remaining = (await readdir(root, { withFileTypes: true })).map((entry) => entry.name);
assert.deepEqual(remaining, ["conversations"], `workspace root should only contain conversations, got ${JSON.stringify(remaining)}`);
const folderNames = (await readdir(folderDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
assert.equal(folderNames.length, 4, `expected 3 conversation folders + unattributed, got ${JSON.stringify(folderNames)}`);
assert.ok(folderNames.includes("_未归属"), "unattributed folder should exist");

const index = await readIndex(root, config);
assert.ok(index.migration?.completedAt, "index should record migration completion");
assert.equal(Object.keys(index.folders).length, 3, "expected 3 session index records");
const toolFolder = index.folders[ids.tool]?.folder;
assert.ok(toolFolder, "tool session should have a folder record");
const toolFiles = await readdir(path.join(folderDir, toolFolder));
assert.deepEqual(toolFiles.sort(), ["project-editor", "tool.py"].sort());
const renderFolder = index.folders[ids.render]?.folder;
assert.deepEqual((await readdir(path.join(folderDir, renderFolder))).sort(), ["notes", "project-render"].sort());

const report = await readFile(path.join(folderDir, "迁移报告.md"), "utf8");
assert.ok(report.includes("未归属") && report.includes("回滚"), "report should contain unattributed and rollback sections");
const rollback = JSON.parse(await readFile(path.join(folderDir, "迁移回滚清单.json"), "utf8"));
assert.equal(rollback.moves.length, 6, "rollback manifest should contain 6 moves");

// ---------- idempotency ----------
const second = await migrateRoot({ root, sessions, config, logger: () => {} });
assert.equal(second.skipped, true, "second migration should be skipped");
assert.equal(second.reason, "already-migrated");

// ---------- multi-frame zstd decoding ----------
const sessionText = [
  JSON.stringify({ type: "session", version: 4, id: "session-test-1", createdAt: now, cwd: root }),
  JSON.stringify({ type: "session/title", seq: 0, time: now, data: { title: "标题" } }),
  JSON.stringify(call(1, "write", { file_path: "a.txt", content: "x" }))
].join("\n");
const lines = sessionText.split("\n");
const frames = [zstdCompressSync(Buffer.from(`${lines[0]}\n`)), zstdCompressSync(Buffer.from(lines.slice(1).join("\n")))];
const sessionFile = path.join(base, "sess", "session.v4.jsonl.zstd");
await mkdir(path.dirname(sessionFile), { recursive: true });
await writeFile(sessionFile, Buffer.concat(frames));
const decoded = readSessionFile(sessionFile);
assert.equal(decoded.header.id, "session-test-1");
assert.equal(decoded.events.length, 2, `expected 2 decoded events, got ${decoded.events.length}`);
assert.equal(decoded.events[1].data.name, "write");

await rm(base, { recursive: true, force: true });
console.log("Smoke test passed ✓");
console.log(`migration log lines: ${logged.length}`);
