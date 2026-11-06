#!/usr/bin/env node
/**
 * 回滚脚本：读取 <工作区>/conversations/迁移回滚清单.json，把条目移回原位置。
 *
 * 用法：
 *   node scripts/rollback.mjs --root "C:\path\to\workspace" --dry-run
 *   node scripts/rollback.mjs --root "C:\path\to\workspace"
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_CONFIG, resolveConfig } from "../lib/config.js";
import { moveEntry } from "../lib/migrate.js";

/**
 * 解析命令行参数。
 * @param argv process.argv.slice(2)。
 * @returns 参数对象。
 */
function parseArgs(argv) {
  const options = { root: null, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = argv[++index];
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
 * 主流程。
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.root) {
    console.log(
      [
        "用法: node scripts/rollback.mjs --root <工作区目录> [--dry-run]",
        "",
        "把 <工作区>/conversations/迁移回滚清单.json 里记录的条目逐个移回原位置。",
        "目标位置已存在时跳过，不覆盖任何文件。"
      ].join("\n")
    );
    if (!options.root && !options.help) process.exitCode = 1;
    return;
  }

  const config = resolveConfig({ ...DEFAULT_CONFIG });
  const root = path.resolve(options.root);
  const manifestFile = path.join(root, config.folderName, config.rollbackFileName);
  let manifest;
  try {
    manifest = JSON.parse((await readFile(manifestFile, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    console.error(`无法读取回滚清单 ${manifestFile}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const moves = Array.isArray(manifest.moves) ? manifest.moves : [];
  console.log(`回滚清单: ${moves.length} 个条目（${manifestFile}）`);
  let moved = 0;
  let skipped = 0;
  for (const item of moves) {
    if (options.dryRun) {
      console.log(`  [dry-run] ${item.to} → ${item.from}`);
      continue;
    }
    const result = await moveEntry(item.to, item.from);
    if (result === "moved") {
      moved += 1;
      console.log(`  已还原: ${item.to} → ${item.from}`);
    } else {
      skipped += 1;
      console.log(`  跳过 (${result === "missing" ? "现位置不存在" : "原位置已存在"}): ${item.to}`);
    }
  }
  if (!options.dryRun) console.log(`回滚完成: 还原 ${moved} 个，跳过 ${skipped} 个`);
}

await main();
