#!/usr/bin/env node
/**
 * 离线迁移脚本：不启动 DSH，直接读取 ~/.dsh/sessions 下的会话日志，
 * 把工作区根目录里散落的条目搬进各自的对话文件夹。
 *
 * 用法：
 *   node scripts/migrate.mjs --root "C:\path\to\workspace" --dry-run
 *   node scripts/migrate.mjs --root "C:\path\to\workspace"
 *   node scripts/migrate.mjs --all
 *
 * 参数：
 *   --root <dir>           要迁移的工作区根目录，可重复
 *   --all                  迁移会话日志里出现过的所有工作区根目录
 *   --sessions-root <dir>  会话存储根目录（默认 ~/.dsh/sessions）
 *   --config <json>        覆盖配置（JSON 字符串）
 *   --dry-run              只打印计划，不移动文件
 *   --help                 显示帮助
 */

import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG, resolveConfig } from "../lib/config.js";
import { migrateRoot } from "../lib/migrate.js";
import { readSessionFile } from "../lib/zstd.js";

/**
 * 解析命令行参数。
 * @param argv process.argv.slice(2)。
 * @returns 参数对象。
 */
function parseArgs(argv) {
  const options = {
    roots: [],
    all: false,
    sessionsRoot: process.env.DSH_SESSIONS_ROOT || path.join(os.homedir(), ".dsh", "sessions"),
    config: {},
    dryRun: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.roots.push(argv[++index]);
    else if (arg === "--all") options.all = true;
    else if (arg === "--sessions-root") options.sessionsRoot = argv[++index];
    else if (arg === "--config") options.config = JSON.parse(argv[++index] ?? "{}");
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else {
      console.error(`未知参数: ${arg}`);
      process.exitCode = 1;
      options.help = true;
    }
  }
  return options;
}

/**
 * 打印帮助。
 */
function printHelp() {
  console.log(
    [
      "用法: node scripts/migrate.mjs --root <工作区目录> [--dry-run]",
      "      node scripts/migrate.mjs --all [--dry-run]",
      "",
      "选项:",
      "  --root <dir>           要迁移的工作区根目录，可重复",
      "  --all                  迁移会话日志里出现过的所有工作区根目录",
      "  --sessions-root <dir>  会话存储根目录（默认 ~/.dsh/sessions）",
      "  --config <json>        覆盖配置（JSON 字符串）",
      "  --dry-run              只打印计划，不移动文件",
      "  --help                 显示帮助",
      "",
      "迁移结果会写入 <工作区>/conversations/迁移报告.md 与 迁移回滚清单.json。"
    ].join("\n")
  );
}

/**
 * 扫描会话存储目录，读出全部会话。
 * @param sessionsRoot 会话存储根目录。
 * @returns 会话数组（`{ file, header, events }`）。
 */
async function loadSessions(sessionsRoot) {
  const sessions = [];
  let workspaceDirs;
  try {
    workspaceDirs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    console.error(`无法读取会话目录 ${sessionsRoot}: ${error.message}`);
    return sessions;
  }
  for (const workspaceDir of workspaceDirs) {
    if (!workspaceDir.isDirectory()) continue;
    const workspacePath = path.join(sessionsRoot, workspaceDir.name);
    let sessionDirs;
    try {
      sessionDirs = await readdir(workspacePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const file = path.join(workspacePath, sessionDir.name, "session.v4.jsonl.zstd");
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        const { header, events } = readSessionFile(file);
        if (header) sessions.push({ file, header, events });
      } catch {
        // 不是会话目录或文件损坏，跳过
      }
    }
  }
  return sessions;
}

/**
 * 主流程。
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.roots.length === 0 && !options.all) {
    console.error("请用 --root 指定工作区目录，或用 --all 处理全部工作区。\n");
    printHelp();
    process.exitCode = 1;
    return;
  }

  const config = resolveConfig({ ...DEFAULT_CONFIG, ...options.config });
  const sessions = await loadSessions(options.sessionsRoot);
  console.log(`读取会话: ${sessions.length} 个（${options.sessionsRoot}）`);

  const byRoot = new Map();
  for (const session of sessions) {
    const cwd = session.header?.cwd;
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) continue;
    const key = path.resolve(cwd).toLowerCase();
    if (!byRoot.has(key)) byRoot.set(key, { root: path.resolve(cwd), sessions: [] });
    byRoot.get(key).sessions.push(session);
  }

  const targets = options.all
    ? [...byRoot.values()]
    : [...new Set(options.roots.map((root) => path.resolve(root).toLowerCase()))].map((key) => {
        const found = byRoot.get(key);
        if (!found) console.warn(`警告: 没有找到属于 ${key} 的会话记录，仍会处理该目录。`);
        return found ?? { root: path.resolve(key), sessions: [] };
      });

  for (const { root, sessions: rootSessions } of targets) {
    console.log(`\n=== 工作区: ${root}（会话 ${rootSessions.length} 个）`);
    const result = await migrateRoot({
      root,
      sessions: rootSessions,
      config,
      dryRun: options.dryRun,
      logger: (message) => console.log(`  ${message}`)
    });
    if (result.skipped) {
      console.log(`  跳过: ${result.reason}`);
      continue;
    }
    if (result.dryRun) {
      const plan = result.plan;
      for (const folder of plan.folders) {
        const items = plan.moves.filter((move) => move.sessionId === folder.sessionId).map((move) => move.top);
        console.log(`  文件夹 ${folder.folder}  ←  ${items.length} 项: ${items.join("、")}`);
      }
      if (plan.unattributed.length > 0) {
        console.log(`  未归属: ${plan.unattributed.map((item) => item.name).join("、")}`);
      }
      if (plan.conflicts.length > 0) {
        console.log(`  冲突: ${plan.conflicts.map((item) => item.name).join("、")}`);
      }
      continue;
    }
    console.log(
      `  完成: 移动 ${result.moved?.length ?? 0} 个，未归属 ${result.unattributed?.length ?? 0} 个，` +
        `冲突 ${result.conflicts?.length ?? 0} 个，跳过 ${result.skippedItems?.length ?? 0} 个`
    );
    console.log(`  报告: ${path.join(root, config.folderName, config.reportFileName)}`);
  }
}

await main();
