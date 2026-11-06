/**
 * 组合包声明校验：检查 dsh-conversation-folders 是否被 profile 正确登记为组合包，
 * 并确认独立的 dsh-conversation-folder-open 已随合并下线。
 *
 * 运行：node test/check-bundle.mjs
 * 只读，不修改 profile。
 */

import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const profileArg = process.argv.indexOf("--profile");
const profile =
  profileArg !== -1 && process.argv[profileArg + 1]
    ? process.argv[profileArg + 1]
    : process.env.DSH_PROFILE_DIR || path.join(os.homedir(), ".dsh", "profiles", "desktop");
const require = createRequire(path.join(profile, "package.json"));
const pkg = JSON.parse(await readFile(path.join(profile, "package.json"), "utf8"));
const bundles = pkg.dsh?.profile?.bundles ?? [];
let failed = false;

for (const name of ["dsh-conversation-folders"]) {
  const dir = path.join(profile, "node_modules", name);
  const info = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  const patchRel = info.dsh?.bundle?.patch;
  const patchOk = patchRel
    ? await stat(path.join(dir, patchRel)).then(() => true, () => false)
    : false;
  const clientRel =
    info.exports && typeof info.exports === "object" ? info.exports["./client"] : info.exports;
  const clientOk = clientRel
    ? await stat(path.join(dir, clientRel)).then(() => true, () => false)
    : false;
  const inDeps = Boolean(pkg.dependencies?.[name]);
  const inBundles = bundles.includes(name);
  const localeOk =
    (await stat(path.join(dir, "locale", "en.json")).then(() => true, () => false)) &&
    (await stat(path.join(dir, "locale", "zh.json")).then(() => true, () => false));
  const iconOk = await stat(path.join(dir, "icon.svg")).then(() => true, () => false);
  const metaExportsOk =
    typeof info.exports === "object" && info.exports["./locale/*.json"] && info.exports["./icon"];

  console.log(name);
  console.log("  dependencies:", inDeps, pkg.dependencies?.[name]);
  console.log("  dsh.profile.bundles:", inBundles);
  console.log("  dsh.bundle.patch:", patchRel, "->", patchOk);
  console.log("  dsh.client:", JSON.stringify(info.dsh?.client ?? null));
  console.log("  exports ./client:", clientRel, "->", clientOk);
  console.log("  locale en/zh + icon:", localeOk, iconOk, "exports:", Boolean(metaExportsOk));

  if (!inDeps || !inBundles || !patchOk || !clientOk || !localeOk || !iconOk || !metaExportsOk) {
    failed = true;
  }
}

// 合并后不应再存在独立包
const legacy = "dsh-conversation-folder-open";
const legacyInstalled = await stat(path.join(profile, "node_modules", legacy)).then(
  () => true,
  () => false
);
console.log(`${legacy} 已下线:`, !legacyInstalled && !bundles.includes(legacy) && !pkg.dependencies?.[legacy]);
if (legacyInstalled || bundles.includes(legacy) || pkg.dependencies?.[legacy]) failed = true;

const yaml = require("yaml");
if (yaml) {
  const doc = yaml.parse(await readFile(path.join(profile, "cordis.patch.yml"), "utf8"));
  const insertIds = doc
    .filter((entry) => entry && Array.isArray(entry.insert))
    .flatMap((entry) => entry.insert.map((item) => item.id));
  console.log("profile patch entries:", doc.length);
  console.log("insert ids:", insertIds.join(", "));
  if (insertIds.includes("conversation-folders") || insertIds.includes("conversation-folder-open")) {
    console.log("警告：profile patch 里仍有手写 insert（应由组合包 patch 提供）");
    failed = true;
  }
}

if (failed) {
  console.error("组合包声明校验失败");
  process.exitCode = 1;
} else {
  console.log("组合包声明校验通过 ✓");
}
