/**
 * 从会话事件日志里提取迁移与命名所需的信息。
 *
 * 兼容两种输入：
 * 1. 运行时的真实 Session（使用 `session.snapshotEvents()` 与 `session.header`）；
 * 2. 离线解析出的普通对象 `{ header, events }`（迁移脚本使用）。
 */

import path from "node:path";

/**
 * 把一条消息事件的内容拼成纯文本。
 * @param data 事件 data。
 * @returns 拼接后的文本。
 */
export function textOfMessageData(data) {
  const content = data && data.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * 提取会话的标题、首条用户文本、最后一次工作目录变更。
 * @param input 运行时 Session 或 `{ header, events }`。
 * @returns `{ header, title, firstUserText, lastCwd }`。
 */
export function summarizeSession(input) {
  const header = input && input.header && typeof input.header === "object" ? input.header : {};
  let events;
  if (Array.isArray(input && input.events)) events = input.events;
  else if (input && typeof input.snapshotEvents === "function") events = input.snapshotEvents();
  else if (input && typeof input.eventAt === "function" && Number.isSafeInteger(input.seq)) {
    events = [];
    for (let seq = 0; seq < input.seq; seq += 1) events.push(input.eventAt(seq));
  } else events = [];

  let title = null;
  let firstAnyUserText = null;
  let firstRealUserText = null;
  let lastCwd = null;

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "session/title") {
      const value = event.data && event.data.title;
      if (typeof value === "string" && value.trim()) title = value.trim();
    } else if (event.type === "user/message") {
      if (firstAnyUserText === null) {
        const text = textOfMessageData(event.data);
        if (text) firstAnyUserText = text;
      }
      if (firstRealUserText === null && event.data && event.data.source && event.data.source.kind === "user") {
        const text = textOfMessageData(event.data);
        if (text) firstRealUserText = text;
      }
    } else if (event.type === "working-directory/change") {
      const cwd = event.data && event.data.cwd;
      if (typeof cwd === "string" && path.isAbsolute(cwd)) lastCwd = cwd;
    }
  }

  return {
    header,
    title,
    firstUserText: firstRealUserText ?? firstAnyUserText,
    lastCwd
  };
}

/**
 * 取会话 id（header.id 或对象的 id 字段）。
 * @param input Session 或 `{ header }`。
 * @returns 会话 id 字符串。
 */
export function sessionIdOf(input) {
  const header = input && input.header;
  if (header && typeof header.id === "string") return header.id;
  if (input && typeof input.id === "string") return input.id;
  return "";
}
