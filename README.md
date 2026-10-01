# gsd-rovo

Embeds [GSD](https://github.com/open-gsd/gsd-core) in the Atlassian Rovo CLI (`rovo`) as an
Embeddable Orchestration System (EoS), through the gsd-core Host-Integration SDK.

Status: early development. Install projects no GSD artifacts yet.

## Usage

```bash
gsd-rovo install [--root <dir>] [--force]
gsd-rovo uninstall [--root <dir>] [--force]
gsd-rovo descriptor
gsd-rovo doctor [--root <dir>]
```

The default root is `~/.rovo`. Set `GSD_ROVO_DEBUG=1` to print stack traces on errors.

## What install changes

- Install writes only inside `skills/` and `subagents/` under the root. It never writes or
  deletes other files, such as `config.yml` or other tools' hooks.
- Install records every file and every directory it creates in
  `<root>/.gsd-rovo-manifest.json`. It writes this record before it writes any file.
- Install refuses, and writes nothing, when a target file exists but is not in the
  manifest, or was changed after the last install. `--force` overwrites.
- Install and uninstall refuse to follow symlinks below the root, and refuse `/` or your
  home directory as the root.
- Uninstall removes only files in the manifest, and only directories that install created.
  It keeps files you changed after install (unless `--force`), and keeps a manifest that
  lists them.

## Host integration axes

| Axis | Value | Basis |
|---|---|---|
| `embeddingMode` | `declarative` | Files are projected into the Rovo config dir |
| `commandSurface` | `prose-only` | Rovo has no custom slash commands; saved prompts take no arguments |
| `dispatch.namedDispatch` / `maxDepth` | `true` / `1` | `invoke_subagents` dispatches a named subagent; deeper nesting is untested |
| `dispatch.isolation` | `none` | No per-subagent worktree |
| other `dispatch` fields | `undocumented` | Not verified |
| `modelMode` | `passive` | Per-agent `model` field in subagent frontmatter |
| `hookBus` | `host` | `eventHooks` in `config.yml` fire on session and tool events. They cannot block a tool call: exit 2 is ignored |
| `stateIO` | `filesystem` | The agent reads and writes workspace files directly |
| `transport` | `mcp` | Rovo runs configured MCP servers; its ACP server advertises MCP support |
| `runtime` | `python` | The Rovo binary is a PyInstaller bundle of a Python app |
| `effortSurface` | `undocumented` | Not verified |

Verified against Rovo CLI 202609.30.1.

## Development

Requires Node 24 (see `.nvmrc`).

```bash
npm ci
npm run lint
npm test
```
