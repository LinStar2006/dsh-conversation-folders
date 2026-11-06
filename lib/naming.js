/**
 * 路径与文件夹命名工具。
 *
 * 文件夹命名规则：`<YYYY-MM-DD>_<标题片段>__<会话 id 前 8 位>`，
 * 例如 `2026-11-06_Python脚本替换图片透明通道__d80a37f3`。
 */

import path from "node:path";

/** 文件名中不允许出现的字符。 */
const ILLEGAL_CHARS = /[<>:"\\/|?*\u0000-\u001f]/g;

/**
 * 把路径规范化为可比较的形式（绝对路径 + 小写 + 去掉尾部分隔符）。
 * Windows 文件系统大小写不敏感，所以比较统一用小写。
 * @param value 任意路径字符串。
 * @returns 规范化后的路径。
 */
export function normalizePath(value) {
  const resolved = path.resolve(String(value));
  const trimmed = resolved.length > 3 ? resolved.replace(/[\\/]+$/, "") : resolved;
  return trimmed.toLowerCase();
}

/**
 * 判断 child 是否位于 parent 内部（不包含相等的情况）。
 * @param parent 父目录。
 * @param child 子路径。
 * @returns 位于内部返回 true。
 */
export function isSubPath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && rel !== "." && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 判断两个路径是否指向同一位置。
 * @param a 路径一。
 * @param b 路径二。
 * @returns 相同返回 true。
 */
export function samePath(a, b) {
  return normalizePath(a) === normalizePath(b);
}

/**
 * 把毫秒时间戳格式化为本地日期 `YYYY-MM-DD`。
 * @param ms 毫秒时间戳。
 * @returns 日期字符串，非法时间返回 `unknown-date`。
 */
export function formatDateStamp(ms) {
  const date = new Date(Number(ms));
  if (!Number.isFinite(date.getTime())) return "unknown-date";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 把标题清洗成适合做文件夹名的片段。
 * @param title 原始标题。
 * @param maxLength 最大字符数（按 Unicode 码点计）。
 * @returns 清洗后的片段，可能为空字符串。
 */
export function slugify(title, maxLength = 30) {
  if (typeof title !== "string") return "";
  let text = title.replace(ILLEGAL_CHARS, "_").replace(/\s+/g, "_").replace(/_+/g, "_");
  text = text.replace(/^[._\s]+|[._\s]+$/g, "");
  const chars = Array.from(text);
  if (chars.length > maxLength) text = chars.slice(0, maxLength).join("");
  return text.replace(/[._\s]+$/g, "");
}

/**
 * 取会话 id 的前 8 个字符用于文件夹名后缀。
 * @param sessionId 会话 id（可能是 `session-` 前缀形式）。
 * @returns 8 位以内的标识。
 */
export function shortSessionId(sessionId) {
  const cleaned = String(sessionId ?? "")
    .replace(/^session-/, "")
    .replace(/[^0-9a-zA-Z]/g, "");
  return cleaned.slice(0, 8) || "unknown";
}

/**
 * 生成基础文件夹名（未去重）。
 * @param params 参数对象。
 * @returns 文件夹名。
 */
export function buildFolderName({ createdAt, title, sessionId, maxSlugLength = 30 }) {
  const stamp = formatDateStamp(createdAt);
  const slug = slugify(title, maxSlugLength) || "会话";
  return `${stamp}_${slug}__${shortSessionId(sessionId)}`;
}

/**
 * 在已占用名称集合中挑选一个不冲突的文件夹名。
 * @param base 基础名。
 * @param taken 已占用名称集合（比较时忽略大小写与尾随点/空格）。
 * @returns 不冲突的名称。
 */
export function uniqueFolderName(base, taken) {
  const used = new Set();
  for (const name of taken ?? []) {
    used.add(String(name).replace(/[. ]+$/, "").toLowerCase());
  }
  const key = (name) => String(name).replace(/[. ]+$/, "").toLowerCase();
  if (!used.has(key(base))) return base;
  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${base}_${index}`;
    if (!used.has(key(candidate))) return candidate;
  }
  return `${base}_${Date.now()}`;
}

/**
 * 列出目录下的直接子项名称；目录不存在时返回空数组。
 * @param dir 目录路径。
 * @param fsPromises node:fs/promises 模块。
 * @returns 名称数组。
 */
export async function listDirNames(fsPromises, dir) {
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}
