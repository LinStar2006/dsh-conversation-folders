/**
 * Client bundle 冒烟测试：在 Node 里模拟 window.__ModuleLoader__ 与 React，
 * 验证 client.js 能被加载、导出 inject/apply，注册配置面板与标题栏按钮两个 slot。
 *
 * 运行：node test/client-smoke.mjs
 */

import assert from "node:assert/strict";

const calls = { load: 0, registrations: [] };
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      calls.load += 1;
      calls.spec = spec;
    }
  }
};
globalThis.document = {
  head: { appendChild: () => {} },
  createElement: () => ({ dataset: {}, textContent: "", remove: () => {} })
};

await import("../client.js");
assert.equal(calls.load, 1, "client bundle 应调用一次 __ModuleLoader__.load");
assert.equal(calls.spec.id, "dsh-conversation-folders");

// 模拟浏览器模块表：只提供 react
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useEffect() {
    return undefined;
  }
};
const module = calls.spec.factory((name) => {
  if (name === "react") return React;
  throw new Error(`unexpected module: ${name}`);
});

assert.deepEqual(module.inject, ["slots", "locale", "configForms", "remote", "remote.session"]);

const form = {
  getSnapshot: () => ({
    status: "ready",
    value: {
      enabled: true,
      folderName: "conversations",
      autoMigrate: true,
      skipGitRepositories: true,
      moveUnattributed: true,
      maxSlugLength: 30
    },
    base: undefined,
    user: undefined,
    revision: 0,
    writable: true
  }),
  subscribe: () => () => {},
  mutate: async () => true
};

const slots = [];
const opened = [];
const ctx = {
  effect(fn) {
    return fn();
  },
  locale: {
    register: () => () => {},
    bind: () => (key) => key
  },
  slots: {
    inject(slot, register) {
      return register();
    },
    register(spec, component) {
      slots.push({ spec, component });
      return () => {};
    }
  },
  configForms: {
    get: () => form,
    whileServed: (_namespaces, register) => register(new Set(["conversation-folders"]))
  },
  remote: {
    session: {
      async openWorkspacePath(request) {
        opened.push(request);
        return { ok: true, opened: true };
      }
    }
  }
};

module.apply(ctx);
assert.equal(slots.length, 2, "应注册 2 个 slot（配置面板 + 标题栏按钮）");

// 配置面板
const configSlot = slots.find((slot) => slot.spec.name === "plugins.bundle.config");
assert.ok(configSlot, "应注册 plugins.bundle.config");
assert.equal(configSlot.spec.key, "dsh-conversation-folders");
const configWrapper = configSlot.component({ t: (key) => key });
const configVnode = configWrapper.type(configWrapper.props);
assert.equal(configVnode.type, "section");
assert.ok(JSON.stringify(configVnode).includes("action.save"), "配置面板应包含保存按钮");

// 标题栏按钮
const buttonSlot = slots.find((slot) => slot.spec.name === "conversation.session.header.utilities");
assert.ok(buttonSlot, "应注册 conversation.session.header.utilities");
assert.equal(buttonSlot.spec.id, "conversation-folder");
assert.equal(buttonSlot.spec.order, -9);

const directory = "C:\\workspace\\conversations\\demo";
const buttonVnode = buttonSlot.component({
  sessionId: "session-1",
  useProjection: (key) => (key === "workingDirectory" ? directory : undefined),
  useSessions: (selector) => selector({ byId: { "session-1": { cwd: "C:\\workspace" } } })
});
assert.equal(buttonVnode.type, "button");
assert.equal(buttonVnode.props.title, "open.tooltip");
assert.equal(buttonVnode.props.disabled, false);
buttonVnode.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(opened.length, 1, "点击应请求 Host 打开目录");
assert.equal(opened[0].path, directory);

// 投影缺失时回退到会话列表的 cwd，且目录不可用时禁用
const fallbackVnode = buttonSlot.component({
  sessionId: "session-1",
  useProjection: () => null,
  useSessions: (selector) => selector({ byId: { "session-1": { cwd: "C:\\workspace" } } })
});
assert.equal(fallbackVnode.props.title, "open.tooltip");
const missingVnode = buttonSlot.component({
  sessionId: "session-x",
  useProjection: () => null,
  useSessions: (selector) => selector({ byId: {} })
});
assert.equal(missingVnode.props.disabled, true);
assert.equal(missingVnode.props.title, "open.unavailable");

console.log("client bundle 冒烟测试通过 ✓");
