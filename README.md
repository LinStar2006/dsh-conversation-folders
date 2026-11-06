# Conversation Folders

A **DSH (DeepSeek Harness)** plugin that gives every conversation its own workspace folder — so files from different conversations no longer pile up in one shared directory.

- Each new conversation gets `<workspace>/conversations/<date>_<title>__<session-id>/`, and the session's working directory is switched there before the first model request.
- Existing conversations are migrated once: top-level files and directories referenced by the session logs are moved into the owning conversation's folder; entries that cannot be attributed safely are collected in `_未归属/`.
- Restoring an old conversation returns it to its own folder via an index file; the session transcript is never rewritten, so migration is reversible.
- The session header gets an **Open current conversation folder** button.

## Features

| | |
| --- | --- |
| Per-conversation folders | Automatically created and entered before the first turn |
| Title-based naming | Folder names follow the conversation title, not the first user message |
| One-time migration | Existing workspace entries are classified from session logs and moved |
| Safe by default | Conflicts are never overwritten; everything is idempotent and reversible |
| Rollback & verification | Recorded move manifest, rollback script, and a verifier |
| In-app configuration | Editable from the **Plugins** page (no config file editing) |
| Open-folder button | Opens the current conversation directory in the system file manager |

## How it works

The plugin is a host-side DSH plugin. It hooks `agent/pre-step`, which runs before the prompt is assembled and the model request is derived.

### Session folder lifecycle

1. On the first step of a top-level session (no `parentSession`, `delegationDepth === 0`), if the session's working directory still points at the workspace root, the plugin computes a folder name.
2. It creates the folder and appends a `working-directory/change` event, which changes the working directory for the upcoming request.
   It appends the event directly instead of calling `workingDirectory.set()` so that no extra user message is injected.
3. The session-to-folder mapping is written to an index file under `conversations/`.
4. When the same conversation is resumed later, the plugin reads the index and switches the working directory back to its folder.

A `working-directory/change` event is a log-only event; it is persisted with the session and replayed on restart. It does not modify the session header, so workspace grouping in the sidebar is unaffected.

### Folder naming

Folder names use the pattern:

```
YYYY-MM-DD_<title-slug>__<first-8-chars-of-session-id>
```

Example: `2025-01-15_report-generation__a1b2c3d4/`

DSH generates the conversation title once, on the first prompt, after the request starts. The plugin must choose a working directory *before* that, so it uses a two-step approach:

1. The first turn uses a temporary name derived from the first user message.
2. When the title becomes available (at `agent/turn-stopping`, or at the next `agent/pre-step` as a fallback), the folder is renamed to the title-based name, the index is updated, and the session's working directory is switched to the new path.
3. On restart, the plugin reconciles folder names with the final titles stored in the session logs.

Slugs are normalized for Windows file names, control characters are removed, and the title part is capped at a configurable length. If the target name is already taken, the existing folder is kept and a warning is logged — files are never overwritten.

### Migration and ownership

Migration classifies each top-level workspace entry using the session transcripts:

- **Strong evidence** — `write` / `edit` calls with `file_path`, `present` files, and `deliverables/presented` paths.
- **Weak evidence** — `read`, `read_image`, `grep`, `glob`, `sidebar_open` paths, and `pwsh` `workdir`.
- Subagent sessions roll their strong evidence up to their parent session (`parentSession`).

An entry is moved only when exactly one session (after roll-up) has strong evidence for it. Entries claimed by several sessions are left in place and listed as conflicts in the migration report. Entries with no strong evidence are collected under `_未归属/`, together with the sessions that weakly referenced them, so they can be sorted out manually.

Migration is idempotent: it runs once, records completion in the index, and skips missing sources or existing targets. Workspace roots that contain a `.git` directory are skipped by default.

## Installation

This package declares `dsh.bundle.patch`, so it is installed as a DSH **bundle**:

1. Copy the package directory into the profile's `node_modules`:

   ```powershell
   Copy-Item -Recurse -Force "<package-dir>" "<profile-dir>\node_modules\dsh-conversation-folders"
   ```

   `<profile-dir>` is the active DSH profile, for example `%USERPROFILE%\.dsh\profiles\<profile>`.

2. Register the bundle in `<profile-dir>\package.json`:

   ```json
   {
     "dependencies": {
       "dsh-conversation-folders": "file:<package-dir>"
     },
     "dsh": {
       "profile": {
         "bundles": ["...", "dsh-conversation-folders"]
       }
     }
   }
   ```

   Registration is what makes it appear under **Plugins → Installed plugins** and loads it as a bundle.

3. Restart DSH.

Do **not** add a manual `insert` for this plugin in `cordis.patch.yml` — the bundle ships its own patch and a manual entry would mount the plugin twice.

After updating the package, copy the new files over the installed copy and restart DSH again.

## Configuration

Open **Plugins → Installed plugins → dsh-conversation-folders**. The configuration panel is rendered below the bundle description. Changes are written to the profile via DSH's config editor and applied immediately.

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `folderName` | `conversations` | Directory that holds all conversation folders |
| `autoMigrate` | `true` | Run the one-time migration on startup |
| `skipGitRepositories` | `true` | Skip migration and directory switching when the workspace root is a Git repository |
| `moveUnattributed` | `true` | Collect unattributed entries under `_未归属/` |
| `maxSlugLength` | `30` | Maximum length of the title part (8–120) |

The following keys are intended for scripts and debugging only and are not exposed in the UI:

| Key | Default |
| --- | --- |
| `unattributedFolder` | `_未归属` |
| `reportFileName` | `迁移报告.md` |
| `indexFileName` | `.dsh-conversation-folders.json` |
| `rollbackFileName` | `迁移回滚清单.json` |
| `dryRun` | `false` |

> DSH's **Settings → Built-in plugins** section is a read-only inventory. Plugin configuration lives on the **Plugins** page, consistent with other third-party bundles.

## Command-line tools

All scripts accept `--root <workspace>` (repeatable), and the session-reading scripts accept `--sessions-root <dir>` (default: `~/.dsh/sessions`) as well as `--config <json>`.

```powershell
# Plan a migration without touching anything
node scripts/migrate.mjs --root <workspace> --dry-run

# Migrate
node scripts/migrate.mjs --root <workspace>

# Revert a migration (skips entries whose original path already exists)
node scripts/rollback.mjs --root <workspace> --dry-run
node scripts/rollback.mjs --root <workspace>

# Verify that every recorded move is still in place; exits non-zero on problems
node scripts/verify.mjs --root <workspace>

# Rename folders that still use the first user message instead of the title
node scripts/reconcile.mjs --root <workspace> --dry-run
node scripts/reconcile.mjs --root <workspace>
```

## Data layout

```
<workspace>/
├─ conversations/
│  ├─ 2025-01-15_report-generation__a1b2c3d4/
│  ├─ 2025-01-16_plugin-scaffold__e5f6a7b8/
│  ├─ _未归属/                          # entries that could not be attributed
│  ├─ .dsh-conversation-folders.json    # session ↔ folder index
│  ├─ 迁移报告.md                       # migration report
│  └─ 迁移回滚清单.json                 # rollback manifest (from → to)
└─ ...
```

The index also stores the configuration snapshot and migration status. The migration report lists every folder, unattributed entries with their weak evidence, conflicts, and skipped items.

## Plugin-page metadata

The bundle card on the **Plugins** page reads its title, description, and icon from package resources:

- `locale/en.json` and `locale/zh.json` — `meta.title` and `meta.description`, selected by UI language;
- `icon.svg` — exposed as `./icon` in `package.json`.

DSH resolves these paths through Node's ESM resolver, so any resource used by the host must be declared in `exports`.

## Requirements

- DSH with the `workingDirectory` and `sessionPersistence` services (present in the standard profile).
- Node.js ≥ 22.15 for the offline scripts (`zlib.zstdCompressSync` / `zstdCompressSync`); the plugin itself runs inside DSH.
- Developed and tested on Windows; path handling is Windows-aware, and folder-name deduplication is case-insensitive.

## Development

```powershell
node test/smoke.mjs          # naming, migration, index, report, multi-frame zstd
node test/startup-smoke.mjs  # startup migration with a fake persistence service
node test/plugin-smoke.mjs   # pre-step folder creation/switching and title renaming
node test/client-smoke.mjs   # client bundle: slots, config panel, open-folder button
node test/check-bundle.mjs   # bundle metadata and local profile registration
```

`check-bundle.mjs` inspects the local DSH profile and is optional outside a development environment.

## Limitations

- The plugin is host-side; installing or updating it requires a DSH restart.
- Migration only moves top-level entries of the workspace root. Nested files stay where they are.
- Files created by shell commands are only attributed when a session log records a path (for example a `write` call or a presented deliverable); otherwise they end up in `_未归属/`.
- Subagent sessions share the parent conversation's folder, by design.
- Renaming never overwrites an existing folder; if the target exists, the original name is kept.

## License

MIT — see [LICENSE](LICENSE).
