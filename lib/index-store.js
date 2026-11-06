/**
 * 会话文件夹索引的读写。
 *
 * 索引文件位于 `<工作区>/<folderName>/.dsh-conversation-folders.json`，
 * 记录 sessionId → 文件夹名 的持久映射，也记录迁移结果，供重启后复用。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** 索引文件路径。 */
export function indexPath(root, config) {
  return path.join(root, config.folderName, config.indexFileName);
}

/** 创建一个空索引。 */
export function emptyIndex() {
  return {
    version: 1,
    plugin: "dsh-conversation-folders",
    updatedAt: null,
    folders: {},
    migration: null
  };
}

/**
 * 读取索引；文件不存在返回 null，内容损坏时把坏文件改名保留并返回 null。
 * @param root 工作区根目录。
 * @param config 插件配置。
 * @returns 索引对象或 null。
 */
export async function readIndex(root, config) {
  const file = indexPath(root, config);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("索引内容不是对象");
    if (!parsed.folders || typeof parsed.folders !== "object" || Array.isArray(parsed.folders)) {
      parsed.folders = {};
    }
    return parsed;
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      await rename(file, backup);
    } catch {
      /* 备份失败不影响流程 */
    }
    return null;
  }
}

/**
 * 原子写入索引：先写临时文件再改名，避免进程中断留下半个文件。
 * @param root 工作区根目录。
 * @param config 插件配置。
 * @param index 索引对象。
 */
export async function writeIndex(root, config, index) {
  const file = indexPath(root, config);
  await mkdir(path.dirname(file), { recursive: true });
  const snapshot = { ...index, version: index.version ?? 1, updatedAt: new Date().toISOString() };
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify(snapshot, null, 2), "utf8");
  await rename(temporary, file);
}

/**
 * 读取会话在索引中的记录。
 * @param index 索引对象或 null。
 * @param sessionId 会话 id。
 * @returns 记录或 undefined。
 */
export function folderRecord(index, sessionId) {
  const folders = index && index.folders;
  if (!folders || typeof folders !== "object") return undefined;
  const record = folders[sessionId];
  return record && typeof record === "object" && typeof record.folder === "string" ? record : undefined;
}

/**
 * 写入会话的文件夹记录，返回更新后的索引。
 * @param index 索引对象（可被就地修改）。
 * @param sessionId 会话 id。
 * @param record 记录内容。
 * @returns 索引对象。
 */
export function setFolderRecord(index, sessionId, record) {
  if (!index.folders || typeof index.folders !== "object") index.folders = {};
  index.folders[sessionId] = { ...record, updatedAt: new Date().toISOString() };
  return index;
}
