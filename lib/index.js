/**
 * 让每个对话拥有独立文件夹的 DSH 主机插件。
 *
 * 工作方式：
 * - 新对话 / 恢复的旧对话在第一次产生请求前（agent/pre-step）检查当前工作目录；
 *   若仍停在工作区根目录，就为它确定一个独立文件夹并切换过去；
 * - 文件夹名写入工作区下的索引文件，恢复旧对话时直接复用同一个文件夹；
 * - 启动时（可配置）对已有工作区做一次性迁移：把根目录里散落的条目按
 *   会话记录搬进各自的文件夹。
 */

import { mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";

import { resolveConfig } from "./config.js";
import { emptyIndex, readIndex, setFolderRecord, writeIndex } from "./index-store.js";

export { Config } from "./settings.js";
import { buildFolderName, isSubPath, samePath, uniqueFolderName } from "./naming.js";
import { normalizeSessionId } from "./plan.js";
import { sessionIdOf, summarizeSession } from "./session-scan.js";
import { migrateAllWorkspaces } from "./startup.js";

export const name = "conversation-folders";
export const inject = ["workingDirectory", "sessionPersistence"];

/**
 * 插件入口。
 * @param ctx Cordis 上下文。
 * @param rawConfig 来自 cordis.patch.yml 的配置。
 */
export function apply(ctx, rawConfig) {
  // 配置字段是 volatile accessor：每次使用都重新解析，设置界面保存后无需重启插件。
  const readConfig = () => resolveConfig(rawConfig);
  const config = readConfig();
  const logger = ctx.logger;
  const log = (level, ...args) => {
    const method = typeof logger?.[level] === "function" ? logger[level].bind(logger) : null;
    if (method) method(...args);
  };

  /**
   * 配置界面由本插件的 client 半自绘（「插件」页里的配置区块），
   * 因此告诉 settings 服务不要为它自动生成表单。
   */
  if (typeof ctx.inject === "function") {
    ctx.inject(["settings"], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
    });
  }

  if (!config.enabled) {
    log("info", "conversation-folders: 插件已禁用（仍保留监听器，保存配置后立即恢复）");
  }

  /** 本进程内已经处理过的会话，避免每个 turn 重复检查。 */
  const handled = new Set();
  /** 每个根目录的索引读写串行队列，防止并发覆盖。 */
  const locks = new Map();

  /**
   * 在某个根目录的锁内执行索引操作。
   * @param root 工作区根目录。
   * @param task 任务函数。
   * @returns 任务结果。
   */
  const withRootLock = (root, task) => {
    const key = path.resolve(root).toLowerCase();
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    locks.set(
      key,
      next.finally(() => {
        if (locks.get(key) === next) locks.delete(key);
      })
    );
    return next;
  };

  /**
   * 取会话文件夹（不存在则生成并写索引），返回绝对路径。
   * @param root 工作区根目录。
   * @param sessionId 会话 id。
   * @param title 会话标题。
   * @param fallbackText 备用命名文本。
   * @param createdAt 会话创建时间（毫秒）。
   * @returns 文件夹绝对路径。
   */
  const ensureFolder = (root, sessionId, title, fallbackText, createdAt) =>
    withRootLock(root, async () => {
      const config = readConfig();
      const folderDir = path.join(root, config.folderName);
      const index = (await readIndex(root, config)) ?? emptyIndex();
      const record = index.folders?.[sessionId];
      if (record && typeof record.folder === "string" && record.folder) {
        return path.join(folderDir, record.folder);
      }
      const existing = await listSubdirectories(folderDir);
      const base = buildFolderName({
        createdAt,
        title: title || fallbackText,
        sessionId,
        maxSlugLength: config.maxSlugLength
      });
      const folder = uniqueFolderName(base, new Set(existing.map((item) => item.toLowerCase())));
      setFolderRecord(index, sessionId, { folder, title: title ?? null, createdAt });
      await writeIndex(root, config, index);
      return path.join(folderDir, folder);
    });

  /**
   * 取会话标题服务（可选依赖）。标题由 DSH 的 session-title 服务生成，
   * 通过 ctx.get 读取，避免把插件变成强依赖。
   * @returns 标题服务或 null。
   */
  const titleService = () => {
    try {
      const service = typeof ctx.get === "function" ? ctx.get("sessionTitle") : undefined;
      return service && typeof service.get === "function" ? service : null;
    } catch {
      return null;
    }
  };

  /**
   * 读取当前会话的最新标题（智能体生成或用户重命名）。
   * @param session 会话实例。
   * @returns 标题或 null。
   */
  const titleOf = (session) => {
    try {
      const service = titleService();
      const state = service?.get?.(session);
      if (state && typeof state.title === "string" && state.title.trim()) return state.title.trim();
    } catch {
      // 标题服务不可用时不阻塞建文件夹，退回会话日志里的标题
    }
    return null;
  };

  /**
   * 在新对话 / 恢复对话的第一个 step 前切换工作目录。
   * @param agent 代理实例。
   * @param decision pre-step 决策（可能含本轮消息）。
   */
  const ensureSessionFolder = async (agent, decision) => {
    const config = readConfig();
    if (!config.enabled) return;
    const session = agent.session;
    const header = session.header ?? {};
    const fullSessionId = sessionIdOf(session);
    const sessionId = normalizeSessionId(fullSessionId);
    if (!sessionId || handled.has(sessionId)) return;
    handled.add(sessionId);

    // 子代理不单独建文件夹，沿用父会话的目录
    if ((header.delegationDepth ?? 0) > 0) return;
    if (typeof header.parentSession === "string" && header.parentSession) return;

    const root = header.cwd;
    if (typeof root !== "string" || !path.isAbsolute(root)) return;

    // 真正的项目（git 仓库）不强制分文件夹，避免把模型的工作目录从工程根目录挪走
    if (config.skipGitRepositories && (await pathExists(path.join(root, ".git")))) return;

    let current;
    try {
      current = ctx.workingDirectory.get(session);
    } catch (error) {
      log("warn", "conversation-folders: 读取当前工作目录失败", error);
      return;
    }
    if (typeof current !== "string") return;
    const defaultDirectory = ctx.workingDirectory.defaultDirectory;
    // 仍停在工作区根目录（或默认目录）时才算“还没分文件夹”；
    // 已经切到自己的文件夹或用户手动 cd 过的情况不动。
    const pending =
      samePath(current, root) ||
      (typeof defaultDirectory === "string" && samePath(current, defaultDirectory));
    if (!pending) return;

    const summary = summarizeSession(session);
    const fallbackText = firstUserTextOf(decision?.messages);
    const createdAt = Number.isFinite(summary.header?.createdAt) ? summary.header.createdAt : Date.now();
    // 标题优先：智能体/用户生成的标题 > 会话日志里的标题 > 本轮第一句用户文本。
    const title = titleOf(session) ?? summary.title;
    const target = await ensureFolder(root, fullSessionId || sessionId, title, fallbackText, createdAt);
    if (isSubPath(path.join(root, config.folderName), target) === false) return;
    await mkdir(target, { recursive: true });
    await switchWorkingDirectory(agent, target);
    log("info", `conversation-folders: 对话 ${sessionId} 使用文件夹 ${target}`);
  };

  /**
   * 直接追加工作目录变更事件（不注入用户消息，避免多一轮对话）。
   * @param agent 代理实例。
   * @param target 目标目录。
   */
  const switchWorkingDirectory = async (agent, target) => {
    const session = agent.session;
    const current = ctx.workingDirectory.get(session);
    if (samePath(current, target)) return;
    session.append("working-directory/change", { cwd: target });
  };

  /**
   * 会话标题生成或修改后，把已建好的文件夹重命名为标题名。
   *
   * 新对话在 pre-step 时标题还没生成，会先按第一句用户文本建临时文件夹；
   * 标题到达后（本轮结束时，或下一轮 pre-step）在这里改成标题名，并把工作
   * 目录切到新路径，避免文件夹名一直是"用户第一句话"。
   *
   * @param agent 代理实例。
   */
  const syncFolderName = async (agent) => {
    const config = readConfig();
    if (!config.enabled) return;
    const session = agent.session;
    const header = session.header ?? {};
    if ((header.delegationDepth ?? 0) > 0) return;
    if (typeof header.parentSession === "string" && header.parentSession) return;
    const root = header.cwd;
    if (typeof root !== "string" || !path.isAbsolute(root)) return;
    if (config.skipGitRepositories && (await pathExists(path.join(root, ".git")))) return;

    const title = titleOf(session);
    if (!title) return;

    const fullSessionId = sessionIdOf(session);
    const sessionId = normalizeSessionId(fullSessionId);
    if (!sessionId) return;

    const moved = await withRootLock(root, async () => {
      const folderDir = path.join(root, config.folderName);
      const index = (await readIndex(root, config)) ?? emptyIndex();
      const record = index.folders?.[fullSessionId] ?? index.folders?.[sessionId];
      if (!record || typeof record.folder !== "string" || !record.folder) return null;
      const createdAt = Number.isFinite(record.createdAt) ? record.createdAt : Date.now();
      const expected = buildFolderName({ createdAt, title, sessionId, maxSlugLength: config.maxSlugLength });
      if (record.folder === expected) {
        if (record.title !== title) {
          record.title = title;
          await writeIndex(root, config, index);
        }
        return null;
      }
      const from = path.join(folderDir, record.folder);
      const to = path.join(folderDir, expected);
      if (!(await pathExists(from))) return null;
      if (await pathExists(to)) {
        log("warn", `conversation-folders: 标题名文件夹 ${expected} 已存在，保留 ${record.folder}`);
        return null;
      }
      await rename(from, to);
      record.folder = expected;
      record.title = title;
      await writeIndex(root, config, index);
      return { from, to };
    });
    if (!moved) return;

    let current;
    try {
      current = ctx.workingDirectory.get(session);
    } catch {
      current = undefined;
    }
    if (samePath(current, moved.from)) {
      session.append("working-directory/change", { cwd: moved.to });
    }
    log("info", `conversation-folders: 对话 ${sessionId} 的文件夹按标题重命名为 ${path.basename(moved.to)}`);
  };

  ctx.on(
    "agent/pre-step",
    async (payload, next) => {
      const decision = await next();
      if (decision && decision.kind === "reject") return decision;
      if (payload?.signal?.aborted) return decision;
      try {
        await ensureSessionFolder(payload.agent, decision);
        await syncFolderName(payload.agent);
      } catch (error) {
        log("warn", "conversation-folders: 切换对话文件夹失败", error);
      }
      return decision;
    },
    { prepend: true }
  );

  // 首轮结束时标题通常已经生成：把按第一句建的临时文件夹改成标题名。
  ctx.on("agent/turn-stopping", async ({ agent }) => {
    try {
      await syncFolderName(agent);
    } catch (error) {
      log("warn", "conversation-folders: 按标题重命名文件夹失败", error);
    }
  });

  if (config.autoMigrate) {
    // 启动迁移放到后台，避免拖慢 DSH 启动
    setTimeout(() => {
      migrateAllWorkspaces({ ctx, config: readConfig(), logger: { info: (...a) => log("info", ...a), warn: (...a) => log("warn", ...a) } })
        .then((summary) => {
          const total = summary.reduce((sum, item) => sum + (item.movedCount ?? 0), 0);
          if (total > 0) log("info", `conversation-folders: 启动迁移完成，共移动 ${total} 个条目`);
        })
        .catch((error) => log("warn", "conversation-folders: 启动迁移失败", error));
    }, 1500).unref?.();
  }
}

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
 * 列出目录下的子目录名。
 * @param dir 目录。
 * @returns 名称数组（目录不存在时为空）。
 */
async function listSubdirectories(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * 从本轮消息里取第一条用户文本，作为文件夹名备选。
 * @param messages 消息数组。
 * @returns 文本或 null。
 */
function firstUserTextOf(messages) {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!message || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return null;
}
