/**
 * 读取会话 zstd 容器（DSH 的 session.v4.jsonl.zstd 由多个 zstd 帧拼接而成，
 * 每帧对应一次 append 批次；Node 的 zstdDecompressSync 只能解压单帧，
 * 所以这里先按帧切分再逐帧解压）。
 */

import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

/** zstd 帧魔数。 */
export const ZSTD_MAGIC = 4247762216;

/**
 * 扫描 buffer 内的所有 zstd 帧边界。
 * @param buffer 文件内容。
 * @returns `{ frames: [{start,end}], tornStart? }`。
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`zstd 帧魔数错误，偏移 ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error("zstd 保留块类型");
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * 解压多帧 zstd buffer。
 * @param buffer 文件内容。
 * @returns 解压后的 buffer。
 */
export function decodeZstdBuffer(buffer) {
  const { frames } = scanZstdFrames(buffer);
  const parts = [];
  for (const { start, end } of frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)));
    } catch {
      // 损坏帧跳过，尽量保留能读到的内容
    }
  }
  return Buffer.concat(parts);
}

/**
 * 解析会话 JSONL 文本。
 * @param text 解压后的文本。
 * @returns `{ header, events }`。
 */
export function parseSessionText(text) {
  let header = null;
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (!header && value.type === "session") {
      header = value;
      continue;
    }
    if (typeof value.type === "string" && typeof value.seq === "number") events.push(value);
  }
  return { header, events };
}

/**
 * 读取一个 session.v4.jsonl.zstd 文件。
 * @param file 文件路径。
 * @returns `{ header, events }`。
 */
export function readSessionFile(file) {
  return parseSessionText(decodeZstdBuffer(readFileSync(file)).toString("utf8"));
}
