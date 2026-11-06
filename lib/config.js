/**
 * 插件配置的默认值与归一化。
 *
 * Config 的字段在 schema 里标记为 volatile，Cordis 传入的配置值因此是
 * cosmokit 的 accessor（用 .get() 读当前值、可被设置界面热更新）。
 * 这里统一解包，并手动校验，任何非法值都退回默认值，保证插件不会因为
 * 配置写错而启动失败。
 */

/** 默认配置。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 是否启用插件。 */
  enabled: true,
  /** 存放各对话文件夹的父目录名（位于工作区根目录下）。 */
  folderName: "conversations",
  /** 启动时是否自动迁移历史对话的文件。 */
  autoMigrate: true,
  /** 是否跳过工作区根目录本身是 git 仓库的会话（避免破坏代码工程）。 */
  skipGitRepositories: true,
  /** 是否把找不到归属的根目录条目集中移动到未归属目录。 */
  moveUnattributed: true,
  /** 未归属条目的集中目录名。 */
  unattributedFolder: "_未归属",
  /** 迁移报告文件名。 */
  reportFileName: "迁移报告.md",
  /** 索引文件名（保存 sessionId → 文件夹名 的映射）。 */
  indexFileName: ".dsh-conversation-folders.json",
  /** 回滚清单文件名。 */
  rollbackFileName: "迁移回滚清单.json",
  /** 文件夹名中的标题片段最大长度。 */
  maxSlugLength: 30,
  /** 只输出迁移计划、不真正移动文件（调试用）。 */
  dryRun: false
});

/** 文件名中不允许出现的字符（Windows 规则，跨平台更安全）。 */
const ILLEGAL_NAME = /[<>:"\\/|?*\u0000-\u001f]/;

/**
 * 读取配置字段的当前值：volatile 字段是 accessor，普通字段直接返回。
 * @param value 配置字段值。
 * @returns 解包后的值。
 */
function unwrap(value) {
  if (value !== null && typeof value === "object" && typeof value.get === "function") {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * 校验并归一化单个可做文件名的字符串配置。
 * @param value 原始值。
 * @param fallback 默认值。
 * @returns 合法值或默认值。
 */
function safeName(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return fallback;
  if (ILLEGAL_NAME.test(trimmed)) return fallback;
  return trimmed;
}

/**
 * 把外部传入的原始配置合并到默认配置上，并修正非法字段。
 * @param raw Cordis 传入的配置对象，可能为空。
 * @returns 完整配置对象。
 */
export function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const resolved = unwrap(value);
      if (resolved !== undefined) config[key] = resolved;
    }
  }
  config.folderName = safeName(config.folderName, DEFAULT_CONFIG.folderName);
  config.unattributedFolder = safeName(config.unattributedFolder, DEFAULT_CONFIG.unattributedFolder);
  config.reportFileName = safeName(config.reportFileName, DEFAULT_CONFIG.reportFileName);
  config.indexFileName = safeName(config.indexFileName, DEFAULT_CONFIG.indexFileName);
  config.rollbackFileName = safeName(config.rollbackFileName, DEFAULT_CONFIG.rollbackFileName);
  if (!Number.isSafeInteger(config.maxSlugLength) || config.maxSlugLength < 8) {
    config.maxSlugLength = DEFAULT_CONFIG.maxSlugLength;
  }
  for (const key of ["enabled", "autoMigrate", "skipGitRepositories", "moveUnattributed", "dryRun"]) {
    config[key] = Boolean(config[key]);
  }
  return config;
}
