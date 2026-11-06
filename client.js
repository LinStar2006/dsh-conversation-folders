/**
 * dsh-conversation-folders 的浏览器半（Client bundle）。
 *
 * 提供两件事：
 * 1. 「插件」页组合包详情里的配置区块（自绘表单，读写插件的 Config）。
 * 2. 会话标题栏右上角一个「打开当前对话文件夹」按钮：读取会话的实时
 *    workingDirectory 投影，让 Host 用系统默认方式打开该目录（原「在应用中打开」
 *    按钮取的是会话 header 里的工作区根目录，不会跟随本插件切换后的目录）。
 *
 * 配置的落盘、revision 与 profile patch 写入全部由 Host 的 settings 服务负责；
 * 打开目录走 remote.session.openWorkspacePath({ path })（省略 action = 系统默认打开）。
 */

window.__ModuleLoader__.load({
  id: "dsh-conversation-folders",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let React = require("react");
    const h = React.createElement;

    /** Host 插件条目的 id（= cordis.patch.yml 里的 id），settings 以它作为 namespace。 */
    const NS = "conversation-folders";
    /** 组合包的 npm 包名，用于 plugins.bundle.config 的 key。 */
    const PACKAGE_NAME = "dsh-conversation-folders";

    const zh = {
      // 配置面板
      "panel.title": "对话独立文件夹",
      "panel.description":
        "新对话会自动在自己的文件夹里工作；旧文件可以按会话记录一次性迁移。下面这些设置保存后立即生效。",
      "field.folderName": "文件夹名称",
      "field.folderName.hint": "工作区里存放各对话文件夹的目录名，默认 conversations。",
      "field.autoMigrate": "启动时自动迁移旧文件",
      "field.autoMigrate.hint": "插件加载时扫描各工作区根目录，把旧对话散落的文件搬进各自文件夹（只执行一次）。",
      "field.skipGitRepositories": "跳过 Git 仓库工作区",
      "field.skipGitRepositories.hint": "当工作区根目录含 .git 时，不切换目录也不迁移，避免破坏版本库结构。",
      "field.moveUnattributed": "集中存放无归属条目",
      "field.moveUnattributed.hint": "找不到所属对话的条目统一放进「_未归属」文件夹，而不是留在根目录。",
      "field.maxSlugLength": "标题截断长度",
      "field.maxSlugLength.hint": "文件夹名里标题部分最多保留多少个字符（8–120）。",
      "action.save": "保存",
      "action.saving": "保存中…",
      "action.saved": "已保存",
      "action.reset": "恢复默认",
      "state.loading": "正在读取配置…",
      "state.unavailable": "配置暂不可用：插件可能尚未加载完成。",
      "state.readonly": "当前配置不可写。",
      "error.invalidFolderName": "文件夹名不能为空，也不能包含 < > : \" / \\ | ? * 或控制字符。",
      "error.invalidMaxSlugLength": "标题截断长度必须是 8 到 120 之间的整数。",
      "error.saveFailed": "保存失败，请查看日志后重试。",
      // 标题栏按钮
      "open.tooltip": "打开当前对话文件夹",
      "open.unavailable": "当前对话目录不可用",
      "open.failed": "打开文件夹失败",
    };

    const en = {
      // Settings panel
      "panel.title": "Per-conversation folders",
      "panel.description":
        "New conversations work inside their own folder; legacy files can be migrated once from session records. Saved values apply immediately.",
      "field.folderName": "Folder name",
      "field.folderName.hint": "Directory under the workspace that holds per-conversation folders. Default: conversations.",
      "field.autoMigrate": "Migrate legacy files on startup",
      "field.autoMigrate.hint": "When the plugin loads, move loose files from old conversations into their folders (runs once).",
      "field.skipGitRepositories": "Skip Git repositories",
      "field.skipGitRepositories.hint": "When the workspace root contains .git, neither switch directories nor migrate.",
      "field.moveUnattributed": "Collect unattributed entries",
      "field.moveUnattributed.hint": "Put entries with no owning conversation into the _未归属 folder instead of leaving them at the root.",
      "field.maxSlugLength": "Title truncation length",
      "field.maxSlugLength.hint": "Maximum characters of the title kept in the folder name (8–120).",
      "action.save": "Save",
      "action.saving": "Saving…",
      "action.saved": "Saved",
      "action.reset": "Restore defaults",
      "state.loading": "Loading configuration…",
      "state.unavailable": "Configuration unavailable: the plugin may still be loading.",
      "state.readonly": "This configuration is read-only.",
      "error.invalidFolderName": "Folder name must not be empty or contain < > : \" / \\ | ? * or control characters.",
      "error.invalidMaxSlugLength": "Truncation length must be an integer between 8 and 120.",
      "error.saveFailed": "Save failed; check the logs and retry.",
      // Header button
      "open.tooltip": "Open conversation folder",
      "open.unavailable": "Conversation folder unavailable",
      "open.failed": "Could not open the folder",
    };

    const CONFIG_CSS = `
.cf-config{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-text-primary);font-size:13px;line-height:1.55;}
.cf-config-header{display:flex;flex-direction:column;gap:4px;}
.cf-config-title{font-size:14px;font-weight:600;}
.cf-config-description{color:var(--dsw-alias-text-secondary);}
.cf-config-field{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-l2);}
.cf-config-row{display:flex;align-items:center;gap:8px;cursor:pointer;}
.cf-config-label{font-weight:500;}
.cf-config-hint{color:var(--dsw-alias-text-secondary);font-size:12px;margin:0;}
.cf-config-input{height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-text-primary);width:100%;box-sizing:border-box;}
.cf-config-input:focus{outline:none;border-color:var(--dsw-alias-border-l4);}
.cf-config-actions{display:flex;align-items:center;gap:10px;}
.cf-config-button{height:30px;padding:0 14px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-text-primary);cursor:pointer;font-size:13px;}
.cf-config-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.cf-config-button:disabled{opacity:.55;cursor:default;}
.cf-config-button.primary{background:var(--dsw-alias-button-primary-bg,var(--dsw-alias-interactive-bg-active));border-color:transparent;}
.cf-config-status{color:var(--dsw-alias-text-secondary);font-size:12px;}
.cf-config-status.error{color:var(--dsw-alias-text-error,inherit);}
.cf-config-muted{color:var(--dsw-alias-text-secondary);}
.cf-open-button{box-sizing:border-box;flex:none;align-self:center;display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 5px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;}
.cf-open-button:hover:not(:disabled),.cf-open-button:focus-visible{background:var(--dsw-alias-interactive-bg-hover);}
.cf-open-button:focus-visible{outline:none;}
.cf-open-button:disabled{cursor:default;opacity:.55;}
.cf-open-button[data-state="error"]{color:var(--dsw-alias-label-danger,var(--dsw-alias-label-primary));}
`;

    /** windows 文件名非法字符。 */
    const ILLEGAL_FOLDER_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

    const FIELDS = [
      { key: "folderName", kind: "text" },
      { key: "autoMigrate", kind: "boolean" },
      { key: "skipGitRepositories", kind: "boolean" },
      { key: "moveUnattributed", kind: "boolean" },
      { key: "maxSlugLength", kind: "number" },
    ];

    /**
     * 配置面板。
     * @param props slot props（含 form 与 t）。
     */
    function ConfigPanel(props) {
      const { form, t } = props;
      const [snap, setSnap] = React.useState(() => form.getSnapshot());
      const [draft, setDraft] = React.useState({});
      const [status, setStatus] = React.useState("idle");
      const [error, setError] = React.useState(null);

      React.useEffect(
        () => form.subscribe(() => setSnap(form.getSnapshot())),
        [form]
      );

      const values = snap.value ?? {};
      const current = (key) => (key in draft ? draft[key] : values[key]);
      const update = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));

      const save = async () => {
        setError(null);
        const folderName = String(current("folderName") ?? "").trim();
        if (!folderName || ILLEGAL_FOLDER_NAME.test(folderName)) {
          setError(t("error.invalidFolderName"));
          return;
        }
        const maxSlugLength = Number(current("maxSlugLength"));
        if (!Number.isInteger(maxSlugLength) || maxSlugLength < 8 || maxSlugLength > 120) {
          setError(t("error.invalidMaxSlugLength"));
          return;
        }
        const ops = [
          { op: "set", path: ["folderName"], value: folderName },
          { op: "set", path: ["autoMigrate"], value: Boolean(current("autoMigrate")) },
          { op: "set", path: ["skipGitRepositories"], value: Boolean(current("skipGitRepositories")) },
          { op: "set", path: ["moveUnattributed"], value: Boolean(current("moveUnattributed")) },
          { op: "set", path: ["maxSlugLength"], value: maxSlugLength },
        ];
        setStatus("saving");
        const ok = await form.mutate(ops, snap.revision);
        if (ok) {
          setStatus("saved");
          setDraft({});
        } else {
          setStatus("idle");
          setError(t("error.saveFailed"));
        }
      };

      const reset = async () => {
        setError(null);
        setStatus("saving");
        const ok = await form.mutate(
          FIELDS.map((field) => ({ op: "unset", path: [field.key] })),
          snap.revision
        );
        setStatus(ok ? "saved" : "idle");
        if (ok) setDraft({});
        else setError(t("error.saveFailed"));
      };

      if (snap.status === "loading") {
        return h("section", { className: "cf-config" }, h("p", { className: "cf-config-muted" }, t("state.loading")));
      }
      if (snap.status !== "ready") {
        return h(
          "section",
          { className: "cf-config" },
          h("p", { className: "cf-config-muted" }, t("state.unavailable"))
        );
      }

      const disabled = !snap.writable || status === "saving";

      return h(
        "section",
        { className: "cf-config" },
        h(
          "div",
          { className: "cf-config-header" },
          h("div", { className: "cf-config-title" }, t("panel.title")),
          h("div", { className: "cf-config-description" }, t("panel.description"))
        ),
        h(
          "div",
          { className: "cf-config-field" },
          h("label", { className: "cf-config-label", htmlFor: "cf-folderName" }, t("field.folderName")),
          h("input", {
            id: "cf-folderName",
            className: "cf-config-input",
            type: "text",
            value: String(current("folderName") ?? ""),
            disabled,
            onChange: (event) => update("folderName", event.target.value),
          }),
          h("p", { className: "cf-config-hint" }, t("field.folderName.hint"))
        ),
        h(booleanField, {
          id: "cf-autoMigrate",
          label: t("field.autoMigrate"),
          hint: t("field.autoMigrate.hint"),
          checked: Boolean(current("autoMigrate")),
          disabled,
          onChange: (checked) => update("autoMigrate", checked),
        }),
        h(booleanField, {
          id: "cf-skipGitRepositories",
          label: t("field.skipGitRepositories"),
          hint: t("field.skipGitRepositories.hint"),
          checked: Boolean(current("skipGitRepositories")),
          disabled,
          onChange: (checked) => update("skipGitRepositories", checked),
        }),
        h(booleanField, {
          id: "cf-moveUnattributed",
          label: t("field.moveUnattributed"),
          hint: t("field.moveUnattributed.hint"),
          checked: Boolean(current("moveUnattributed")),
          disabled,
          onChange: (checked) => update("moveUnattributed", checked),
        }),
        h(
          "div",
          { className: "cf-config-field" },
          h("label", { className: "cf-config-label", htmlFor: "cf-maxSlugLength" }, t("field.maxSlugLength")),
          h("input", {
            id: "cf-maxSlugLength",
            className: "cf-config-input",
            type: "number",
            min: 8,
            max: 120,
            step: 1,
            value: Number.isFinite(Number(current("maxSlugLength"))) ? Number(current("maxSlugLength")) : 30,
            disabled,
            onChange: (event) => update("maxSlugLength", event.target.value === "" ? "" : Number(event.target.value)),
          }),
          h("p", { className: "cf-config-hint" }, t("field.maxSlugLength.hint"))
        ),
        h(
          "div",
          { className: "cf-config-actions" },
          h(
            "button",
            { type: "button", className: "cf-config-button primary", disabled, onClick: save },
            status === "saving" ? t("action.saving") : status === "saved" ? t("action.saved") : t("action.save")
          ),
          h("button", { type: "button", className: "cf-config-button", disabled, onClick: reset }, t("action.reset")),
          error ? h("span", { className: "cf-config-status error" }, error) : null,
          !snap.writable ? h("span", { className: "cf-config-status" }, t("state.readonly")) : null
        )
      );
    }

    /** 一个带标题与说明的复选框字段。 */
    function booleanField(props) {
      return h(
        "div",
        { className: "cf-config-field" },
        h(
          "label",
          { className: "cf-config-row", htmlFor: props.id },
          h("input", {
            id: props.id,
            type: "checkbox",
            checked: props.checked,
            disabled: props.disabled,
            onChange: (event) => props.onChange(event.target.checked),
          }),
          h("span", { className: "cf-config-label" }, props.label)
        ),
        h("p", { className: "cf-config-hint" }, props.hint)
      );
    }

    /** 文件夹图标（自绘，避免引入 DSH 客户端包的图标）。 */
    function FolderOpenIcon({ size = 13 }) {
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
          style: { display: "block" },
        },
        h("path", { d: "M1.75 4.25a1 1 0 0 1 1-1h3.1l1.4 1.6h6a1 1 0 0 1 1 1v1.1" }),
        h("path", { d: "M1.75 6.55h12.5l-1.45 5.1a1 1 0 0 1-.96.72H3.41a1 1 0 0 1-.96-.72L1.75 6.55Z" })
      );
    }

    /**
     * 注册配置面板与标题栏按钮所需的文案、样式与 slot。
     * @param ctx Client 插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "conversation-folders: locale");

      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-conversation-folders";
        tag.textContent = CONFIG_CSS;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, "conversation-folders: styles");

      const t = ctx.locale.bind(NS);

      // ── 1. 插件页配置面板 ──────────────────────────────────────────────
      const form = ctx.configForms.get(NS);

      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () =>
            ctx.slots.inject("plugins.bundle.config", () =>
              ctx.slots.register(
                { name: "plugins.bundle.config", key: PACKAGE_NAME, locale: NS },
                (props) => h(ConfigPanel, { ...props, form })
              )
            )
          ),
        "conversation-folders: config panel"
      );

      // ── 2. 标题栏「打开当前对话文件夹」按钮 ────────────────────────────
      // Host 的 schema 只接受 action: "reveal"；省略 action 表示用系统默认方式打开，
      // 对目录来说就是资源管理器直接进入该目录。
      const openFolder = async (target) => {
        try {
          const result = await ctx.remote.session.openWorkspacePath({ path: target });
          if (result != null && result.ok === true) return true;
          console.warn("conversation-folders: host rejected the open request", result);
        } catch (error) {
          console.warn("conversation-folders: open path rejected", error);
        }
        return false;
      };

      /**
       * 标题栏按钮：目录来自会话实时的 workingDirectory 投影，回退到会话列表行的 cwd。
       * @param props slot props（sessionId、useProjection、useSessions）。
       */
      function OpenConversationFolder(props) {
        const { sessionId, useProjection, useSessions } = props;
        const projected = useProjection("workingDirectory");
        const fallback = useSessions((state) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd));
        const directory = typeof projected === "string" && projected.length > 0 ? projected : fallback;
        const [pending, setPending] = React.useState(false);
        const [failed, setFailed] = React.useState(false);

        const label = directory === undefined || directory === null ? t("open.unavailable") : t("open.tooltip");
        const click = () => {
          if (directory === undefined || directory === null || pending) return;
          setPending(true);
          setFailed(false);
          openFolder(directory).then((ok) => {
            setPending(false);
            setFailed(!ok);
          });
        };

        return h(
          "button",
          {
            type: "button",
            className: "cf-open-button",
            title: failed ? t("open.failed") : label,
            "aria-label": failed ? t("open.failed") : label,
            "data-state": pending ? "busy" : failed ? "error" : "idle",
            disabled: pending || directory === undefined || directory === null,
            onClick: click,
          },
          h(FolderOpenIcon, { size: 13 })
        );
      }

      ctx.slots.inject("conversation.session.header.utilities", () =>
        ctx.slots.register(
          {
            name: "conversation.session.header.utilities",
            id: "conversation-folder",
            order: -9,
            locale: NS,
          },
          OpenConversationFolder
        )
      );
    }

    exports.inject = ["slots", "locale", "configForms", "remote", "remote.session"];
    exports.apply = apply;
    return module.exports;
  },
});
