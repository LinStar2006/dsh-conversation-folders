/**
 * 插件入口的冒烟测试：用假 ctx 触发 agent/pre-step，验证会建文件夹并追加目录变更事件。
 *
 * 运行：node test/plugin-smoke.mjs
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const pluginUrl = new URL("../lib/index.js", import.meta.url).href;
const { apply, Config } = await import(pluginUrl);

// 导出的 Config 应能被 settings 服务识别（组合包配置页的 schema 来源）。
// volatile 字段是 cosmokit accessor，用 .get() 读默认值。
assert.ok(Config, "应导出 Config");
const resolvedConfig = Config({});
assert.equal(resolvedConfig.folderName.get(), "conversations", "默认文件夹名应为 conversations");
assert.equal(resolvedConfig.autoMigrate.get(), true, "默认应自动迁移");
assert.equal(resolvedConfig.maxSlugLength.get(), 30, "默认标题截断长度应为 30");

/**
 * 假 ctx 的 inject：模拟 settings 服务，让 configure 分支也被执行。
 * @param deps 依赖的服务名列表。
 * @param callback 服务就绪后的回调。
 */
function fakeInject(deps, callback) {
  const settings = { configure: () => () => {} };
  callback({
    settings,
    effect: (fn) => fn()
  });
  return () => {};
}

const root = await mkdtemp(path.join(os.tmpdir(), "cf-plugin-"));
const appended = [];
let current = root;
const listeners = [];

const ctx = {
  logger: { info: () => {}, warn: (...args) => console.warn("warn:", ...args) },
  workingDirectory: {
    defaultDirectory: root,
    get: () => current
  },
  inject: fakeInject,
  on(event, listener) {
    listeners.push({ event, listener });
  }
};

const session = {
  header: { type: "session", version: 4, id: "session-bbbb2222-0000-4000-8000-000000000001", createdAt: Date.now(), cwd: root, delegationDepth: 0 },
  append(type, data) {
    appended.push({ type, data });
    if (type === "working-directory/change") current = data.cwd;
  }
};
const agent = { session };

apply(ctx, { autoMigrate: false });

const preStep = listeners.find((item) => item.event === "agent/pre-step");
assert.ok(preStep, "应注册 agent/pre-step 监听器");

const decision = { messages: [{ role: "user", content: [{ type: "text", text: "给图片换透明通道" }] }] };
const result = await preStep.listener({ agent, turn: 1, step: 1, signal: undefined }, async () => decision);
assert.equal(result, decision, "应原样放行 pre-step 决策");

assert.equal(appended.length, 1, `应追加 1 个事件，实际 ${appended.length}`);
assert.equal(appended[0].type, "working-directory/change");
const target = appended[0].data.cwd;
assert.ok(target.startsWith(path.join(root, "conversations") + path.sep), `目标应在 conversations 下: ${target}`);
assert.ok(target.includes("给图片换透明通道"), `文件夹名应包含标题: ${target}`);

const folderEntries = await readdir(path.join(root, "conversations"), { withFileTypes: true });
assert.equal(folderEntries.filter((entry) => entry.isDirectory()).length, 1, "应创建 1 个对话文件夹");

const index = JSON.parse(await readFile(path.join(root, "conversations", ".dsh-conversation-folders.json"), "utf8"));
assert.ok(index.folders[session.header.id], "索引应记录该会话的文件夹");

// 第二次触发（同一进程）应直接跳过
await preStep.listener({ agent, turn: 2, step: 1, signal: undefined }, async () => decision);
assert.equal(appended.length, 1, "同一进程内不应重复切换");

// 恢复的旧会话：当前目录回到根目录，但索引里已有文件夹 → 复用同一个文件夹
const resumedAppended = [];
let resumedCurrent = root;
const resumedSession = {
  header: { type: "session", version: 4, id: session.header.id, createdAt: Date.now(), cwd: root, delegationDepth: 0 },
  append(type, data) {
    resumedAppended.push({ type, data });
    if (type === "working-directory/change") resumedCurrent = data.cwd;
  }
};
const resumedAgent = { session: resumedSession };
const resumedCtx = {
  logger: ctx.logger,
  workingDirectory: { defaultDirectory: root, get: () => resumedCurrent },
  inject: fakeInject,
  on(event, listener) {
    listeners.push({ event, listener: async (...args) => listener(...args) });
  }
};
// 用同一份假 ctx 重新 apply 会重复注册；直接取新注册的监听器
const before = listeners.length;
apply(resumedCtx, { autoMigrate: false });
const resumedPreStep = listeners[before];
await resumedPreStep.listener({ agent: resumedAgent, turn: 3, step: 1, signal: undefined }, async () => decision);
assert.equal(resumedAppended.length, 1, "恢复旧会话应切换一次");
assert.equal(resumedAppended[0].data.cwd, target, "恢复旧会话应复用索引里的文件夹");

// git 仓库工作区默认不强制切文件夹（避免把工程根目录挪走）
const gitRoot = await mkdtemp(path.join(os.tmpdir(), "cf-git-"));
await mkdir(path.join(gitRoot, ".git"), { recursive: true });
const gitAppended = [];
const gitListeners = [];
const gitSession = {
  header: { type: "session", version: 4, id: "session-cccc3333-0000-4000-8000-000000000002", createdAt: Date.now(), cwd: gitRoot, delegationDepth: 0 },
  append(type, data) {
    gitAppended.push({ type, data });
  }
};
apply(
  {
    logger: ctx.logger,
    workingDirectory: { defaultDirectory: gitRoot, get: () => gitRoot },
    inject: fakeInject,
    on(event, listener) {
      gitListeners.push({ event, listener });
    }
  },
  { autoMigrate: false }
);
const gitPreStep = gitListeners.find((item) => item.event === "agent/pre-step");
await gitPreStep.listener({ agent: { session: gitSession }, turn: 1, step: 1 }, async () => decision);
assert.equal(gitAppended.length, 0, "git 仓库工作区不应切换目录");
await rm(gitRoot, { recursive: true, force: true });

// 标题生成后：turn-stopping 应把按第一句建的临时文件夹重命名为标题名
let titleState;
ctx.get = (nameOfService) => (nameOfService === "sessionTitle" ? { get: () => titleState } : undefined);
const turnStopping = listeners.find((item) => item.event === "agent/turn-stopping");
assert.ok(turnStopping, "应注册 agent/turn-stopping 监听器");
titleState = { title: "替换图片透明通道工具" };
await turnStopping.listener({ agent });
const dirsAfterTitle = (await readdir(path.join(root, "conversations"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const renamed = dirsAfterTitle.find((nameOfFolder) => nameOfFolder.includes("替换图片透明通道工具"));
assert.ok(renamed, `文件夹应按标题重命名，实际：${dirsAfterTitle.join(", ")}`);
assert.ok(!dirsAfterTitle.some((nameOfFolder) => nameOfFolder.includes("给图片换透明通道")), "旧的第一句文件夹应已被重命名");
const lastChange = appended.filter((item) => item.type === "working-directory/change").at(-1);
assert.ok(lastChange.data.cwd.endsWith(renamed), "工作目录应切换到重命名后的文件夹");
const indexAfterTitle = JSON.parse(await readFile(path.join(root, "conversations", ".dsh-conversation-folders.json"), "utf8"));
assert.equal(indexAfterTitle.folders[session.header.id].folder, renamed, "索引里的文件夹名应更新");

await rm(root, { recursive: true, force: true });
console.log("插件入口冒烟测试通过 ✓");
