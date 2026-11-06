#!/usr/bin/env node
/**
 * 校验脚本：检查工作区的对话文件夹、索引与回滚清单是否一致，确认没有文件丢失。
 *
 * 用法：
 *   node scripts/verify.mjs --root "C:\path\to\workspace"
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_CONFIG, resolveConfig } from "../lib/config.js";

/**
 * 解析命令行参数。
 * @param argv process.argv.slice(2)。
 * @returns 参数对象。
 */
function parseArgs(argv) {
  const options = { root: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = argv[++index];
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
 * 判断路径是否存在且为目录。
 * @param target 路径。
 * @returns 是否为目录。
 */
async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 判断路径是否存在。
 * @param target 路径。
 * @returns 是否存在。
 */
async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 主流程。
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.root) {
    console.log("用法: node scripts/verify.mjs --root <工作区目录>");
    if (!options.root && !options.help) process.exitCode = 1;
    return;
  }

  const config = resolveConfig({ ...DEFAULT_CONFIG });
  const root = path.resolve(options.root);
  const folderDir = path.join(root, config.folderName);
  const problems = [];

  console.log(`工作区: ${root}`);

  const rootEntries = await readdir(root);
  const unexpected = rootEntries.filter((name) => name !== config.folderName);
  console.log(`根目录条目: ${rootEntries.length} 个（应为 1 个：${config.folderName}/）`);
  if (unexpected.length > 0) problems.push(`根目录仍有未归位的条目: ${unexpected.join(", ")}`);

  if (!(await isDirectory(folderDir))) {
    problems.push(`对话文件夹目录不存在: ${folderDir}`);
  }

  let index = null;
  try {
    index = JSON.parse((await readFile(path.join(folderDir, config.indexFileName), "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    problems.push(`无法读取索引: ${error.message}`);
  }

  const folders = index && typeof index.folders === "object" && index.folders ? index.folders : {};
  const records = Object.entries(folders);
  console.log(`索引记录: ${records.length} 个会话`);
  let totalItems = 0;
  for (const [sessionId, record] of records) {
    const folderPath = path.isAbsolute(record.folder) ? record.folder : path.join(folderDir, record.folder);
    if (!(await isDirectory(folderPath))) {
      problems.push(`索引中的文件夹不存在: ${record.folder}（会话 ${sessionId}）`);
      continue;
    }
    const items = await readdir(folderPath);
    totalItems += items.length;
    console.log(`  ${record.folder} — ${items.length} 项`);
  }

  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(path.join(folderDir, config.rollbackFileName), "utf8"));
  } catch {
    manifest = null;
  }
  const moves = manifest && Array.isArray(manifest.moves) ? manifest.moves : [];
  console.log(`回滚清单记录: ${moves.length} 条移动`);
  let missing = 0;
  for (const item of moves) {
    if (!(await exists(item.to))) {
      missing += 1;
      problems.push(`回滚清单中的现位置不存在: ${item.to}`);
    }
  }
  console.log(`已迁移条目仍在位: ${moves.length - missing}/${moves.length}`);
  console.log(`对话文件夹内条目合计: ${totalItems} 项（含 _未归属）`);

  if (problems.length > 0) {
    console.error(`\n发现 ${problems.length} 个问题:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n校验通过：索引、对话文件夹与回滚清单一致，根目录已清理。");
}

await main();
