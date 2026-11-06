/**
 * 启动迁移：把工作区根目录里散落的条目按会话记录搬进各自的对话文件夹。
 *
 * 通过 `ctx.sessionPersistence.list()` 找到全部已存会话，按 header.cwd 分组，
 * 每组对应一个工作区根目录，逐个读取事件后调用 migrateRoot 完成迁移。
 */

import { rename, stat } from "node:fs/promises";
import path from "node:path";

import { readIndex, writeIndex } from "./index-store.js";
import { migrateRoot } from "./migrate.js";
import { buildFolderName } from "./naming.js";
import { normalizeSessionId } from "./plan.js";
import { summarizeSession } from "./session-scan.js";

/**
 * 判断路径是否存在（任何类型）。
 * @param target 路径。
 * @returns 是否存在。
 */
async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把已经建好的对话文件夹名改成会话标题名。
 *
 * 早期版本在标题生成前就建文件夹，用了用户第一句话；这里在启动时按会话日志里
 * 的最终标题做一次纠正，避免历史会话文件夹名停留在第一句话。
 *
 * @param params 参数对象。
 * @param params.root 工作区根目录。
 * @param params.sessions 该工作区的会话列表（`{ header, events }`）。
 * @param params.config 插件配置。
 * @param params.logger 日志对象（`{ info, warn }`）。
 * @param params.dryRun 只计算重命名计划，不实际改名。
 * @returns `{ renamed: [{ from, to }] }`。
 */
export async function reconcileRoot({ root, sessions, config, logger = {}, dryRun = false }) {
  if (!config.enabled) return { renamed: [] };
  const index = await readIndex(root, config);
  if (!index || !index.folders) return { renamed: [] };

  const titles = new Map();
  for (const session of sessions) {
    const summary = summarizeSession(session);
    const id = summary.header?.id;
    if (typeof id === "string" && id && summary.title) titles.set(id, summary.title);
  }

  const folderDir = path.join(root, config.folderName);
  const renamed = [];
  let dirty = false;
  for (const [sessionId, record] of Object.entries(index.folders)) {
    if (!record || typeof record.folder !== "string" || !record.folder) continue;
    const title = titles.get(sessionId);
    if (!title) continue;
    const createdAt = Number.isFinite(record.createdAt) ? record.createdAt : Date.now();
    const expected = buildFolderName({
      createdAt,
      title,
      sessionId: normalizeSessionId(sessionId),
      maxSlugLength: config.maxSlugLength
    });
    if (record.folder === expected) {
      if (record.title !== title) {
        record.title = title;
        dirty = true;
      }
      continue;
    }
    const from = path.join(folderDir, record.folder);
    const to = path.join(folderDir, expected);
    if (!(await pathExists(from)) || (await pathExists(to))) continue;
    if (dryRun) {
      renamed.push({ from, to, dryRun: true });
      continue;
    }
    try {
      await rename(from, to);
    } catch (error) {
      logger.warn?.(`conversation-folders: 重命名 ${record.folder} -> ${expected} 失败`, error?.message ?? error);
      continue;
    }
    record.folder = expected;
    record.title = title;
    renamed.push({ from, to });
    dirty = true;
  }
  if (dirty) await writeIndex(root, config, index);
  return { renamed };
}

/**
 * 读取一个会话的 header 与全部事件。
 * @param persistence sessionPersistence 服务。
 * @param id 会话 id。
 * @returns `{ header, events }`。
 */
export async function readStoredSession(persistence, id) {
  const handle = await persistence.open(id, "read");
  try {
    const header = handle.header ?? (await persistence.stat(id))?.header ?? null;
    const result = await handle.read();
    return { header, events: result?.events ?? [] };
  } finally {
    try {
      await handle.close();
    } catch {
      // 关闭失败不影响迁移
    }
  }
}

/**
 * 对所有工作区执行一次迁移。
 *
 * @param params 参数对象。
 * @param params.ctx Cordis 上下文（提供 sessionPersistence）。
 * @param params.config 插件配置。
 * @param params.logger 日志对象（`{ info, warn }`）。
 * @returns 各工作区的迁移结果摘要。
 */
export async function migrateAllWorkspaces({ ctx, config, logger = {} }) {
  const persistence = ctx.sessionPersistence;
  if (!persistence || typeof persistence.list !== "function") {
    logger.warn?.("conversation-folders: 没有可用的 sessionPersistence，跳过启动迁移");
    return [];
  }

  const snapshots = await persistence.list();
  const groups = new Map();
  for (const snapshot of snapshots ?? []) {
    const header = snapshot?.header;
    const cwd = header?.cwd;
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) continue;
    if (!header?.id) continue;
    const key = path.resolve(cwd).toLowerCase();
    if (!groups.has(key)) groups.set(key, { root: path.resolve(cwd), headers: [] });
    groups.get(key).headers.push(header);
  }

  const summaries = [];
  for (const { root, headers } of groups.values()) {
    const sessions = [];
    for (const header of headers) {
      try {
        const stored = await readStoredSession(persistence, header.id);
        if (stored && stored.header) sessions.push(stored);
        else sessions.push({ header, events: [] });
      } catch (error) {
        logger.warn?.(`conversation-folders: 读取会话 ${header.id} 失败，跳过`, error?.message ?? error);
        sessions.push({ header, events: [] });
      }
    }
    try {
      const result = await migrateRoot({
        root,
        sessions,
        config,
        dryRun: config.dryRun,
        logger: (message) => logger.info?.(message)
      });
      let renamedCount = 0;
      if (!config.dryRun) {
        try {
          const reconcile = await reconcileRoot({ root, sessions, config, logger });
          renamedCount = reconcile.renamed.length;
          if (renamedCount > 0) {
            logger.info?.(`conversation-folders: ${root} 按标题重命名了 ${renamedCount} 个对话文件夹`);
          }
        } catch (error) {
          logger.warn?.(`conversation-folders: 工作区 ${root} 文件夹名校正失败`, error?.message ?? error);
        }
      }
      summaries.push({
        root,
        skipped: result.skipped ?? false,
        reason: result.reason ?? null,
        movedCount: result.moved?.length ?? 0,
        unattributedCount: result.unattributed?.length ?? 0,
        conflictCount: result.conflicts?.length ?? 0,
        renamedCount
      });
    } catch (error) {
      logger.warn?.(`conversation-folders: 工作区 ${root} 迁移失败`, error?.message ?? error);
      summaries.push({ root, skipped: true, reason: "error", error: String(error?.message ?? error) });
    }
  }
  return summaries;
}
