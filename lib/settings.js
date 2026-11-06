/**
 * 插件的配置 schema。
 *
 * 所有字段都标记为 volatile：DSH 的 settings 服务只会把「包含 volatile 字段」
 * 的插件条目暴露给配置界面，并允许在插件运行中即时保存（无需重载插件）。
 */

import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  folderName: z.string().default("conversations").volatile(),
  autoMigrate: z.boolean().default(true).volatile(),
  skipGitRepositories: z.boolean().default(true).volatile(),
  moveUnattributed: z.boolean().default(true).volatile(),
  maxSlugLength: z.number().step(1).min(8).max(120).default(30).volatile(),
});
