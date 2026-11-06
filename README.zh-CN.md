# 对话独立文件夹（dsh-conversation-folders）

[English](README.md) | **简体中文**

这是一个 **DSH（DeepSeek Harness）** 插件：为每个对话分配独立的工作文件夹，避免不同对话产生的文件全部堆在同一个工作区根目录里。

- 新对话会自动创建并进入 `<工作区>/conversations/<日期>_<标题>__<会话 id 前 8 位>/`，从第一轮请求开始就在自己的目录里工作。
- 已有对话只需迁移一次：根据会话日志里记录的文件路径，把相关文件移到对应对话的文件夹；无法安全判断归属的条目集中到 `_未归属/`。
- 恢复旧对话时，插件通过索引把工作目录切回该对话的文件夹；不会改写会话日志，因此迁移随时可以回滚。
- 会话标题栏右侧提供一个「打开当前对话文件夹」按钮。

## 功能

| | |
| --- | --- |
| 对话独立文件夹 | 首次对话前自动创建并进入 |
| 标题命名 | 文件夹名跟随会话标题，而不是第一句用户消息 |
| 一次性迁移 | 根据会话日志归类并移动已有文件 |
| 默认安全 | 不覆盖冲突条目；操作幂等、可回滚 |
| 回滚与校验 | 记录移动清单，提供回滚脚本和校验脚本 |
| 界面配置 | 在「插件」页直接编辑，无需手改配置文件 |
| 打开文件夹按钮 | 在系统文件管理器中打开当前对话目录 |

## 工作原理

插件运行在 DSH 的 Host 侧，挂载点是 `agent/pre-step`，它在提示词组装和模型请求派生之前执行。

### 会话文件夹的生命周期

1. 顶层会话（没有 `parentSession`、`delegationDepth === 0`）的第一个 step 执行时，如果工作目录仍指向工作区根目录，插件会计算文件夹名。
2. 创建文件夹，并追加一条 `working-directory/change` 事件，使接下来的请求使用新目录。
   这里直接追加事件，而不调用 `workingDirectory.set()`，以避免插件额外注入一条用户消息、导致多一轮对话。
3. 会话与文件夹的映射写入 `conversations/` 下的索引文件。
4. 之后再次恢复同一对话时，插件读取索引，把工作目录切回该文件夹。

`working-directory/change` 是只写入日志的事件：它随会话持久化，重启后仍会重放；它不修改会话 header，因此侧栏的工作区分组不受影响。

### 文件夹命名

文件夹名的格式为：

```
YYYY-MM-DD_<标题片段>__<会话 id 前 8 位>
```

例如：`2025-01-15_report-generation__a1b2c3d4/`

DSH 的会话标题在第一轮请求开始后才由模型生成。插件必须在标题可用之前就决定工作目录，因此采用两步命名：

1. 第一轮先用第一条用户消息生成临时名称；
2. 标题可用后（`agent/turn-stopping`，或下一轮 `agent/pre-step` 兜底）把文件夹重命名为标题名，更新索引，并把会话工作目录切到新路径；
3. 启动时再根据会话日志里的最终标题校正一次文件夹名。

标题片段会按 Windows 文件名规则清洗，去除控制字符，并按可配置长度截断。目标名已存在时保留原名并记录警告，绝不覆盖文件。

### 迁移与归属规则

迁移依据会话日志对工作区根目录的每个顶层条目做归属判断：

- **强证据**：`write` / `edit` 的 `file_path`、`present` 的 `files`、`deliverables/presented` 事件里的路径。
- **弱证据**：`read`、`read_image`、`grep`、`glob`、`sidebar_open` 的路径，以及 `pwsh` 的 `workdir`。
- 子代理会话的强证据会沿 `parentSession` 上卷给父会话。

只有当恰好一个会话（上卷后）对某个条目有强证据时才会移动。多个会话都声明过的条目保留原位，并在迁移报告的「冲突」一节列出。没有强证据的条目集中到 `_未归属/`，同时附上弱证据相关的会话，便于人工归类。

迁移是幂等的：只执行一次，把完成状态写进索引；源不存在或目标已存在都会跳过。工作区根目录包含 `.git` 时默认跳过迁移。

## 安装

### 方式 A：从 DSH 插件页安装（推荐）

1. 打开左侧「插件」页，点右上角 **添加插件**。
2. 在输入框里粘贴下面任意一种：

   ```
   https://github.com/LinStar2006/dsh-conversation-folders
   ```

   - 简写形式：`github:LinStar2006/dsh-conversation-folders`
   - 本地源码目录：`C:\path\to\dsh-conversation-folders`

3. 安装源保持默认值，点 **安装**，按提示重启 DSH。

安装器会自动把包写进 profile 的 `dependencies` 和 `dsh.profile.bundles`。正是这次登记让插件出现在「插件 → 已安装插件」里，所以不需要手动改 `cordis.patch.yml`。

### 方式 B：手动复制到 profile

本包声明了 `dsh.bundle.patch`，因此按 DSH 的「组合包（bundle）」方式安装：

1. 把包目录复制到 profile 的 `node_modules`：

   ```powershell
   Copy-Item -Recurse -Force "<包目录>" "<profile 目录>\node_modules\dsh-conversation-folders"
   ```

   `<profile 目录>` 是当前启用的 DSH profile，例如 `%USERPROFILE%\.dsh\profiles\<profile>`。

2. 在 `<profile 目录>\package.json` 中登记：

   ```json
   {
     "dependencies": {
       "dsh-conversation-folders": "file:<包目录>"
     },
     "dsh": {
       "profile": {
         "bundles": ["...", "dsh-conversation-folders"]
       }
     }
   }
   ```

   只有完成登记，它才会出现在「插件 → 已安装插件」里，并作为组合包被加载。

3. 重启 DSH。

不要在 `cordis.patch.yml` 里为本插件手写 `insert`：组合包自带 patch，重复挂载会导致插件被加载两次。

更新包之后，把新文件复制覆盖到安装副本，再重启 DSH。

## 配置

打开「插件 → 已安装插件 → dsh-conversation-folders」，描述下方就是配置面板。保存后由 DSH 的配置编辑器写入当前 profile，立即生效。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `folderName` | `conversations` | 存放所有对话文件夹的目录名 |
| `autoMigrate` | `true` | 启动时执行一次性迁移 |
| `skipGitRepositories` | `true` | 工作区根目录是 Git 仓库时跳过迁移与切目录 |
| `moveUnattributed` | `true` | 无归属条目是否集中到 `_未归属/` |
| `maxSlugLength` | `30` | 文件夹名中标题片段的最大长度（8–120） |

以下键仅用于脚本和调试，不在界面中展示：

| 键 | 默认值 |
| --- | --- |
| `unattributedFolder` | `_未归属` |
| `reportFileName` | `迁移报告.md` |
| `indexFileName` | `.dsh-conversation-folders.json` |
| `rollbackFileName` | `迁移回滚清单.json` |
| `dryRun` | `false` |

> DSH 设置里的「内置插件」分区是只读清单；插件配置的正式位置是「插件」页的组合包详情，与其他第三方插件一致。

## 命令行工具

所有脚本都支持 `--root <工作区>`（可重复）；读取会话的脚本还支持 `--sessions-root <目录>`（默认 `~/.dsh/sessions`）和 `--config <json>`。

```powershell
# 只打印迁移计划
node scripts/migrate.mjs --root <工作区> --dry-run

# 正式迁移
node scripts/migrate.mjs --root <工作区>

# 回滚（原位置已存在时跳过，不覆盖）
node scripts/rollback.mjs --root <工作区> --dry-run
node scripts/rollback.mjs --root <工作区>

# 校验记录中的移动是否都还在位；有问题时退出码非 0
node scripts/verify.mjs --root <工作区>

# 把仍用第一句用户消息命名的文件夹改成标题名
node scripts/reconcile.mjs --root <工作区> --dry-run
node scripts/reconcile.mjs --root <工作区>
```

## 数据结构

```
<工作区>/
├─ conversations/
│  ├─ 2025-01-15_report-generation__a1b2c3d4/
│  ├─ 2025-01-16_plugin-scaffold__e5f6a7b8/
│  ├─ _未归属/                          # 无法判断归属的条目
│  ├─ .dsh-conversation-folders.json    # 会话 ↔ 文件夹 索引
│  ├─ 迁移报告.md                       # 迁移报告
│  └─ 迁移回滚清单.json                 # 回滚清单（from → to）
└─ ...
```

索引同时保存配置快照和迁移状态。迁移报告包含每个对话文件夹、未归属条目及其弱证据、冲突和跳过项。

## 插件页的展示

「插件」页的组合包卡片从包内资源读取标题、简介和图标：

- `locale/en.json`、`locale/zh.json` 中的 `meta.title` 与 `meta.description`（随界面语言切换）；
- `icon.svg`（在 `package.json` 里暴露为 `./icon`）。

DSH 通过 Node 的 ESM resolver 读取这些资源，因此 Host 侧用到的资源都必须在 `exports` 中声明。

## 环境要求

- DSH 需要提供 `workingDirectory` 与 `sessionPersistence` 服务（标准 profile 已包含）。
- 离线脚本需要 Node.js ≥ 22.15（`zlib.zstdCompressSync` / `zstdCompressSync`）；插件本身运行在 DSH 内。
- 在 Windows 上开发和测试；路径处理面向 Windows，文件夹名去重不区分大小写。

## 开发与测试

```powershell
node test/smoke.mjs          # 命名、迁移、索引、报告、多帧 zstd 解码
node test/startup-smoke.mjs  # 用假 persistence 服务验证启动迁移
node test/plugin-smoke.mjs   # pre-step 创建/切换文件夹与标题重命名
node test/client-smoke.mjs   # client bundle：槽位、配置面板、打开文件夹按钮
node test/check-bundle.mjs   # 组合包元数据与本地 profile 登记
```

`check-bundle.mjs` 会检查本机的 DSH profile，在开发环境之外可跳过。

## 限制

- 插件属于 Host 侧插件，安装或更新后必须重启 DSH。
- 迁移只处理工作区根目录的顶层条目，嵌套文件保持原位。
- 通过 shell 命令创建的文件，只有在会话日志记录了路径时才能归属（例如 `write` 调用或交付物）；否则会进入 `_未归属/`。
- 子代理会话与父对话共用文件夹，这是有意设计。
- 重命名不会覆盖已存在的文件夹；目标名冲突时保留原名。

## 许可证

MIT，见 [LICENSE](LICENSE)。
