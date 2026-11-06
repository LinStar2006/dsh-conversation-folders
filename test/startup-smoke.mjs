/**
 * 启动迁移的冒烟测试：用假的 sessionPersistence 验证 migrateAllWorkspaces 的分组与迁移。
 *
 * 运行：node test/startup-smoke.mjs
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG, resolveConfig } from "../lib/config.js";
import { migrateAllWorkspaces } from "../lib/startup.js";

const base = await mkdtemp(path.join(os.tmpdir(), "cf-startup-"));
const root = path.join(base, "ws");
const now = Date.now();

await mkdir(path.join(root, "Gadget"), { recursive: true });
await writeFile(path.join(root, "Gadget", "g.cs"), "// g");
await writeFile(path.join(root, "stray.bin"), "bin");

const stored = new Map();
const addSession = (id, title, filePath) => {
  stored.set(id, {
    header: { type: "session", version: 4, id, createdAt: now, cwd: root, delegationDepth: 0 },
    events: [
      { type: "session/title", seq: 0, time: now, data: { title } },
      {
        type: "tool/call",
        seq: 1,
        time: now,
        data: { turn: 1, step: 1, callId: "c1", name: "write", arguments: JSON.stringify({ file_path: filePath, content: "x" }) }
      }
    ]
  });
};
addSession("session-aaaa1111-0000-4000-8000-000000000001", "造个零件", path.join(root, "Gadget", "g.cs"));

const skipped = [];
const persistence = {
  async list() {
    return [...stored.values()].map((session) => ({ header: session.header, revision: "1" }));
  },
  async open(id) {
    const session = stored.get(id);
    if (!session) throw new Error(`missing ${id}`);
    return {
      header: session.header,
      async read() {
        return { events: session.events };
      },
      async close() {
        skipped.push(id);
      }
    };
  }
};

const config = resolveConfig({ ...DEFAULT_CONFIG });
const logs = [];
const summaries = await migrateAllWorkspaces({
  ctx: { sessionPersistence: persistence },
  config,
  logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) }
});

assert.equal(summaries.length, 1, "应处理 1 个工作区");
assert.equal(summaries[0].movedCount, 1, `应移动 1 个条目，实际 ${summaries[0].movedCount}`);
assert.equal(summaries[0].unattributedCount, 1, "stray.bin 应进入未归属");
assert.deepEqual(await readdir(root), ["conversations"], "根目录应只剩 conversations");
const folders = (await readdir(path.join(root, "conversations"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
assert.equal(folders.length, 2, "应有 1 个对话文件夹 + _未归属");
assert.deepEqual(skipped, ["session-aaaa1111-0000-4000-8000-000000000001"], "读取后应关闭 handle");

await rm(base, { recursive: true, force: true });
console.log("启动迁移冒烟测试通过 ✓");
console.log(`日志: ${logs.join(" | ")}`);
