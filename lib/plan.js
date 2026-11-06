/**
 * 迁移计划的纯逻辑：根据会话事件日志判断每个根目录条目属于哪个会话。
 *
 * 归属规则：
 * - 强证据：write / edit 的 file_path、present 的 files、deliverables/presented
 *   事件里的 files[].path —— 模型确实写出过的文件；
 * - 弱证据：read / read_image 的 file_path、grep / glob 的 path、
 *   sidebar_open 的 target、pwsh 的 workdir —— 只能说明“碰过”；
 * - 子代理会话（有 parentSession）的证据上卷给它的顶层父会话；
 * - 只有一个会话有强证据的条目才移动；多会话共用则保留原位并记录冲突；
 * - 没有强证据的条目集中移动到未归属目录（`.dsh-` 开头的临时目录
 *   在只有一个会话有弱证据时也归给该会话）。
 */

import path from "node:path";

import { buildFolderName, isSubPath, uniqueFolderName } from "./naming.js";

/** 视为强证据的工具。 */
const STRONG_TOOLS = new Set(["write", "edit", "present"]);

/** 弱证据工具的路径参数名。 */
const WEAK_PATH_ARGUMENTS = new Map([
  ["read", "file_path"],
  ["read_image", "file_path"],
  ["grep", "path"],
  ["glob", "path"],
  ["sidebar_open", "target"]
]);

/**
 * 去掉 `session-` 前缀，得到统一的会话 id 形式。
 * @param value 会话 id。
 * @returns 规范化 id。
 */
export function normalizeSessionId(value) {
  return String(value ?? "").replace(/^session-/, "");
}

/**
 * 解析工具调用里写到的路径，并求出它属于根目录下的哪个顶层条目。
 * @param rawPath 原始路径（可能是相对路径）。
 * @param root 工作区根目录。
 * @returns 顶层条目名，或 null。
 */
function topEntryOf(rawPath, root) {
  if (typeof rawPath !== "string" || !rawPath.trim()) return null;
  let absolute = rawPath.trim();
  if (!path.isAbsolute(absolute)) absolute = path.resolve(root, absolute);
  if (!isSubPath(root, absolute)) return null;
  const first = path.relative(path.resolve(root), path.resolve(absolute)).split(/[\\/]/)[0];
  if (!first || first === "." || first === "..") return null;
  return first;
}

/**
 * 从一条事件中提取它引用的顶层条目（强证据与弱证据分开）。
 * @param event 会话事件。
 * @param root 工作区根目录。
 * @param strong 强证据集合（会被修改）。
 * @param weak 弱证据集合（会被修改）。
 */
function collectEventReferences(event, root, strong, weak) {
  if (!event || typeof event !== "object") return;

  // 交付物事件：路径最可靠
  if (event.type === "deliverables/presented") {
    const files = event.data && event.data.files;
    if (Array.isArray(files)) {
      for (const file of files) {
        const entry = topEntryOf(file && file.path, root);
        if (entry) strong.add(entry);
      }
    }
    return;
  }

  if (event.type !== "tool/call") return;
  const data = event.data ?? {};
  const toolName = typeof data.name === "string" ? data.name : "";
  let args = data.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return;
    }
  }
  if (!args || typeof args !== "object") return;

  if (STRONG_TOOLS.has(toolName)) {
    if (toolName === "present") {
      const files = args.files;
      if (Array.isArray(files)) {
        for (const file of files) {
          const value = typeof file === "string" ? file : file && file.path;
          const entry = topEntryOf(value, root);
          if (entry) strong.add(entry);
        }
      }
    } else {
      const entry = topEntryOf(args.file_path, root);
      if (entry) strong.add(entry);
    }
    return;
  }

  const weakKey = WEAK_PATH_ARGUMENTS.get(toolName);
  if (weakKey) {
    const entry = topEntryOf(args[weakKey], root);
    if (entry) weak.add(entry);
    return;
  }

  if (toolName === "pwsh") {
    const entry = topEntryOf(args.workdir, root);
    if (entry) weak.add(entry);
  }
}

/**
 * 根据会话事件收集引用信息。
 * @param events 会话事件数组。
 * @param root 工作区根目录。
 * @returns `{ strong: Set<string>, weak: Set<string> }`。
 */
export function collectReferences(events, root) {
  const strong = new Set();
  const weak = new Set();
  for (const event of events ?? []) collectEventReferences(event, root, strong, weak);
  return { strong, weak };
}

/**
 * 沿 parentSession 链找到顶层父会话。
 * @param sessionId 会话 id。
 * @param sessionIds 全部会话 id 集合。
 * @param parentOf 子 → 父 映射。
 * @returns 顶层会话 id。
 */
function rootSessionOf(sessionId, sessionIds, parentOf) {
  let current = sessionId;
  const visited = new Set();
  for (;;) {
    if (visited.has(current)) return current;
    visited.add(current);
    const parent = parentOf.get(current);
    if (!parent || !sessionIds.has(parent)) return current;
    current = parent;
  }
}

/**
 * 构建迁移计划。
 *
 * @param params 参数对象。
 * @param params.root 工作区根目录。
 * @param params.sessions 会话数组（`{ header, events }`），应包含根目录下的全部会话（含子代理）。
 * @param params.entries 根目录下现有的直接子项名称。
 * @param params.existingFolders 已存在的对话文件夹名（用于避免重名）。
 * @param params.index 现有索引（用于复用已有文件夹名）。
 * @param params.config 插件配置。
 * @returns 计划对象。
 */
export function buildPlan({ root, sessions, entries, existingFolders, index, config }) {
  const folderName = config.folderName;
  const unattributedFolder = config.unattributedFolder;
  const reserved = new Set([
    folderName,
    config.indexFileName,
    config.reportFileName,
    config.rollbackFileName,
    unattributedFolder
  ]);

  // 只处理根目录下的会话
  const rootKey = normalizePathKey(root);
  const relevant = (sessions ?? []).filter((session) => {
    const cwd = session && session.header && session.header.cwd;
    return typeof cwd === "string" && normalizePathKey(cwd) === rootKey;
  });

  const sessionIds = new Set(relevant.map((session) => normalizeSessionId(sessionIdOfHeader(session))));
  const parentOf = new Map();
  for (const session of relevant) {
    const id = normalizeSessionId(sessionIdOfHeader(session));
    const parent = session.header && session.header.parentSession;
    if (id && parent) parentOf.set(id, normalizeSessionId(parent));
  }

  // 收集每个会话的引用，并把子代理的证据上卷给顶层父会话
  const strongOwners = new Map(); // 条目名 → Set<顶层会话 id>
  const weakOwners = new Map();
  const addOwner = (map, entry, sessionId) => {
    if (!map.has(entry)) map.set(entry, new Set());
    map.get(entry).add(sessionId);
  };
  for (const session of relevant) {
    const id = normalizeSessionId(sessionIdOfHeader(session));
    const owner = rootSessionOf(id, sessionIds, parentOf);
    const { strong, weak } = collectReferences(session.events, root);
    for (const entry of strong) addOwner(strongOwners, entry, owner);
    for (const entry of weak) addOwner(weakOwners, entry, owner);
  }

  // 目录条目：排除插件自己的文件/目录
  const names = (entries ?? []).filter((name) => !reserved.has(name));

  const assignments = new Map(); // 会话 id → 条目名[]
  const conflicts = [];
  const unattributed = [];
  for (const name of names) {
    const strong = strongOwners.get(name);
    const weak = weakOwners.get(name);
    if (strong && strong.size === 1) {
      assignTo(assignments, [...strong][0], name);
      continue;
    }
    if (strong && strong.size > 1) {
      conflicts.push({ name, sessions: [...strong] });
      continue;
    }
    if (name.startsWith(".dsh-") && weak && weak.size === 1) {
      assignTo(assignments, [...weak][0], name);
      continue;
    }
    unattributed.push({ name, weak: weak ? [...weak] : [] });
  }

  // 复用索引里已有的文件夹名，避免重复生成
  const taken = new Set((existingFolders ?? []).map((name) => String(name).toLowerCase()));
  const plannedFolders = new Map();
  const plannedFullIds = new Map();
  const folders = [];
  for (const [sessionId, assigned] of assignments) {
    if (assigned.length === 0) continue;
    const session = relevant.find((item) => normalizeSessionId(sessionIdOfHeader(item)) === sessionId);
    const summary = sessionSummary(session);
    const fullId = sessionIdOfHeader(session) || sessionId;
    plannedFullIds.set(sessionId, fullId);
    // 兼容旧索引（键可能是去掉 session- 前缀的形式）
    const record = getIndexFolder(index, fullId) ?? getIndexFolder(index, sessionId);
    let folder = record;
    if (!folder) {
      const base = buildFolderName({
        createdAt: summary.header.createdAt,
        title: summary.title || summary.firstUserText,
        sessionId,
        maxSlugLength: config.maxSlugLength
      });
      folder = uniqueFolderName(base, taken);
      taken.add(folder.toLowerCase());
    }
    plannedFolders.set(sessionId, folder);
    folders.push({
      sessionId: fullId,
      folder,
      title: summary.title || summary.firstUserText || null,
      createdAt: summary.header.createdAt ?? null
    });
  }

  const folderDir = path.join(root, folderName);
  const moves = [];
  for (const [sessionId, assigned] of assignments) {
    const folder = plannedFolders.get(sessionId);
    if (!folder) continue;
    for (const name of assigned) {
      moves.push({
        sessionId: plannedFullIds.get(sessionId) ?? sessionId,
        top: name,
        from: path.join(root, name),
        to: path.join(folderDir, folder, name)
      });
    }
  }
  moves.sort((left, right) => left.from.localeCompare(right.from, "zh-CN"));

  const unattributedMoves = config.moveUnattributed
    ? unattributed.map((item) => ({
        top: item.name,
        weak: item.weak,
        from: path.join(root, item.name),
        to: path.join(folderDir, unattributedFolder, item.name)
      }))
    : [];

  return {
    root,
    folderDir,
    folders,
    moves,
    unattributed,
    unattributedMoves,
    conflicts
  };
}

/**
 * 往 assignments 里登记一个条目。
 * @param assignments 会话 → 条目名[] 映射。
 * @param sessionId 会话 id。
 * @param name 条目名。
 */
function assignTo(assignments, sessionId, name) {
  if (!assignments.has(sessionId)) assignments.set(sessionId, []);
  assignments.get(sessionId).push(name);
}

/**
 * 取会话 header 的 id。
 * @param session `{ header }`。
 * @returns id。
 */
function sessionIdOfHeader(session) {
  return (session && session.header && session.header.id) || "";
}

/**
 * 路径比较用的键（复用 naming.normalizePath 但避免循环依赖问题）。
 * @param value 路径。
 * @returns 小写规范化路径。
 */
function normalizePathKey(value) {
  return path.resolve(String(value)).replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * 会话摘要（标题 / 首条用户文本 / header）。
 * @param session `{ header, events }`。
 * @returns 摘要对象。
 */
function sessionSummary(session) {
  const header = session && session.header ? session.header : {};
  let title = null;
  let firstUserText = null;
  for (const event of (session && session.events) ?? []) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "session/title") {
      const value = event.data && event.data.title;
      if (typeof value === "string" && value.trim()) title = value.trim();
    } else if (event.type === "user/message" && firstUserText === null) {
      const content = event.data && event.data.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((part) => part && part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (text) firstUserText = text;
      }
    }
  }
  return { header, title, firstUserText };
}

/**
 * 从索引里取会话已有的文件夹名。
 * @param index 索引对象。
 * @param sessionId 会话 id。
 * @returns 文件夹名或 null。
 */
function getIndexFolder(index, sessionId) {
  const record = index && index.folders ? index.folders[sessionId] : undefined;
  return record && typeof record.folder === "string" && record.folder ? record.folder : null;
}
