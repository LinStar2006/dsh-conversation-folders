/**
 * 迁移执行：按计划创建对话文件夹、移动根目录条目、写索引 / 报告 / 回滚清单。
 *
 * 整个流程是幂等的：目标已存在或源已不存在时跳过；索引写完后再次运行
 * 只会看到 `migration.completedAt` 并直接返回。
 */

import { cp, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildPlan } from "./plan.js";
import { emptyIndex, readIndex, setFolderRecord, writeIndex } from "./index-store.js";

/**
 * 递归复制（跨卷 rename 失败时的兜底）。
 * @param from 源。
 * @param to 目标。
 */
async function copyTree(from, to) {
  await cp(from, to, { recursive: true, force: false, errorOnExist: true });
}

/**
 * 判断路径是否存在。
 * @param target 路径。
 * @returns 存在返回 true。
 */
async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

/**
 * 移动文件或目录；目标已存在时返回 `exists`，不覆盖。
 * @param from 源。
 * @param to 目标。
 * @returns `moved` | `exists` | `missing`。
 */
export async function moveEntry(from, to) {
  if (!(await exists(from))) return "missing";
  if (await exists(to)) return "exists";
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await rename(from, to);
    return "moved";
  } catch (error) {
    if (error && (error.code === "EXDEV" || error.code === "EPERM" || error.code === "EACCES")) {
      await copyTree(from, to);
      await rm(from, { recursive: true, force: true });
      return "moved";
    }
    throw error;
  }
}

/**
 * 生成中文迁移报告。
 * @param params 参数对象。
 * @returns Markdown 文本。
 */
function renderReport({ plan, moves, unattributedMoves, conflicts, skipped, config, root }) {
  const lines = [];
  lines.push("# DSH 对话文件夹迁移报告", "");
  lines.push(`- 生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  lines.push(`- 工作区根目录：\`${root}\``);
  lines.push(`- 对话文件夹目录：\`${path.join(root, config.folderName)}\``);
  lines.push(`- 已移动条目：${moves.length} 个`);
  lines.push(`- 未归属条目：${unattributedMoves.length} 个（集中到 \`${config.unattributedFolder}/\`）`);
  lines.push(`- 冲突条目：${conflicts.length} 个（多会话共用，保留原位）`);
  lines.push(`- 跳过条目：${skipped.length} 个`);
  lines.push("");

  if (plan.folders.length > 0) {
    lines.push("## 对话文件夹", "");
    lines.push("| 会话 | 文件夹 | 移动条目数 |");
    lines.push("| --- | --- | --- |");
    for (const folder of plan.folders) {
      const count = moves.filter((move) => move.sessionId === folder.sessionId).length;
      lines.push(`| ${folder.title || folder.sessionId} | \`${folder.folder}\` | ${count} |`);
    }
    lines.push("");
  }

  if (unattributedMoves.length > 0) {
    lines.push(`## 未归属条目（已移入 \`${config.unattributedFolder}/\`）`, "");
    for (const move of unattributedMoves) {
      const weak = move.weak.length > 0 ? `；弱证据会话：${move.weak.join("、")}` : "";
      lines.push(`- \`${move.top}\`${weak}`);
    }
    lines.push("");
  }

  if (conflicts.length > 0) {
    lines.push("## 冲突条目（多个会话都写过，保留原位）", "");
    for (const conflict of conflicts) {
      lines.push(`- \`${conflict.name}\`；涉及会话：${conflict.sessions.join("、")}`);
    }
    lines.push("");
  }

  if (skipped.length > 0) {
    lines.push("## 跳过条目", "");
    for (const item of skipped) lines.push(`- \`${item.top}\`：${item.reason}`);
    lines.push("");
  }

  lines.push("## 回滚方式", "");
  lines.push(
    `所有移动记录保存在 \`${config.rollbackFileName}\` 中（` +
      "`from` 为原位置、`to` 为现位置）。把这些条目从 `to` 移回 `from` 即可还原。"
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * 对一个工作区根目录执行迁移。
 *
 * @param params 参数对象。
 * @param params.root 工作区根目录。
 * @param params.sessions 该根目录下的全部会话（`{ header, events }`）。
 * @param params.config 插件配置。
 * @param params.dryRun 只计算不执行。
 * @param params.logger 日志函数（可选）。
 * @returns 结果摘要。
 */
export async function migrateRoot({ root, sessions, config, dryRun = false, logger }) {
  const folderDir = path.join(root, config.folderName);
  const log = (...args) => {
    if (typeof logger === "function") logger(...args);
  };

  let entries = [];
  try {
    entries = (await readdir(root, { withFileTypes: true })).map((entry) => entry.name);
  } catch (error) {
    log(`迁移跳过: 无法读取工作区目录 ${root}`, error);
    return { skipped: true, reason: "unreadable-root" };
  }

  const index = (await readIndex(root, config)) ?? emptyIndex();
  if (index.migration && index.migration.completedAt) {
    log(`迁移跳过: 已有迁移记录 ${root}`);
    return { skipped: true, reason: "already-migrated", index };
  }

  // 工作区本身是 git 仓库时不动它的文件，避免破坏工程结构
  if (config.skipGitRepositories && (await exists(path.join(root, ".git")))) {
    log(`迁移跳过: ${root} 是 git 仓库`);
    return { skipped: true, reason: "git-repository" };
  }

  const business = entries.filter(
    (name) =>
      name !== config.folderName &&
      name !== config.indexFileName &&
      name !== config.reportFileName &&
      name !== config.rollbackFileName &&
      name !== config.unattributedFolder
  );
  if (business.length === 0) {
    log(`迁移跳过: 工作区根目录没有需要整理的条目 ${root}`);
    return { skipped: true, reason: "empty-root" };
  }

  const existingFolders = await listFolderDir(folderDir);
  const plan = buildPlan({
    root,
    sessions,
    entries: business,
    existingFolders,
    index,
    config
  });

  if (dryRun) {
    log(`[dry-run] ${root}: 计划移动 ${plan.moves.length} 个条目，未归属 ${plan.unattributedMoves.length} 个，冲突 ${plan.conflicts.length} 个`);
    return { dryRun: true, plan };
  }

  // 创建各会话的文件夹
  for (const folder of plan.folders) {
    await mkdir(path.join(folderDir, folder.folder), { recursive: true });
  }
  if (plan.unattributedMoves.length > 0) {
    await mkdir(path.join(folderDir, config.unattributedFolder), { recursive: true });
  }

  const movedRecords = [];
  const skipped = [];

  for (const move of plan.moves) {
    try {
      const result = await moveEntry(move.from, move.to);
      if (result === "moved") {
        movedRecords.push(move);
        log(`已移动: ${move.from} → ${move.to}`);
      } else {
        skipped.push({ top: move.top, reason: result === "missing" ? "源不存在" : "目标已存在" });
      }
    } catch (error) {
      skipped.push({ top: move.top, reason: `移动失败: ${error.message}` });
      log(`移动失败: ${move.from} → ${move.to}`, error);
    }
  }

  const unattributedRecords = [];
  for (const move of plan.unattributedMoves) {
    try {
      const result = await moveEntry(move.from, move.to);
      if (result === "moved") {
        unattributedRecords.push(move);
        log(`已移动(未归属): ${move.from} → ${move.to}`);
      } else {
        skipped.push({ top: move.top, reason: result === "missing" ? "源不存在" : "目标已存在" });
      }
    } catch (error) {
      skipped.push({ top: move.top, reason: `移动失败: ${error.message}` });
      log(`移动失败: ${move.from} → ${move.to}`, error);
    }
  }

  // 记录会话文件夹映射
  for (const folder of plan.folders) {
    setFolderRecord(index, folder.sessionId, {
      folder: folder.folder,
      title: folder.title,
      createdAt: folder.createdAt
    });
  }

  index.migration = {
    completedAt: new Date().toISOString(),
    folderName: config.folderName,
    moved: movedRecords.map((move) => ({ from: move.from, to: move.to, sessionId: move.sessionId })),
    unattributed: unattributedRecords.map((move) => ({ from: move.from, to: move.to, weak: move.weak })),
    conflicts: plan.conflicts,
    skipped
  };
  await writeIndex(root, config, index);

  const report = renderReport({
    plan,
    moves: movedRecords,
    unattributedMoves: unattributedRecords,
    conflicts: plan.conflicts,
    skipped,
    config,
    root
  });
  await writeFile(path.join(folderDir, config.reportFileName), report, "utf8");

  const rollback = {
    generatedAt: new Date().toISOString(),
    root,
    note: "把 to 移回 from 即可撤销迁移。",
    moves: [
      ...movedRecords.map((move) => ({ from: move.from, to: move.to })),
      ...unattributedRecords.map((move) => ({ from: move.from, to: move.to }))
    ]
  };
  await writeFile(path.join(folderDir, config.rollbackFileName), JSON.stringify(rollback, null, 2), "utf8");

  log(
    `迁移完成 ${root}: 移动 ${movedRecords.length} 个，未归属 ${unattributedRecords.length} 个，` +
      `冲突 ${plan.conflicts.length} 个，跳过 ${skipped.length} 个`
  );
  return {
    skipped: false,
    moved: movedRecords,
    unattributed: unattributedRecords,
    conflicts: plan.conflicts,
    skippedItems: skipped,
    plan
  };
}

/**
 * 列出对话文件夹目录下已存在的子目录名；目录不存在返回空数组。
 * @param folderDir 对话文件夹父目录。
 * @returns 名称数组。
 */
async function listFolderDir(folderDir) {
  try {
    const entries = await readdir(folderDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}
