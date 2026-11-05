# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Aria is a Tauri v2 desktop application — a networking workbench and authorized auditing tool with downloads as a secondary capability. The frontend is TypeScript/Vite and the backend is Rust. The two sides communicate over Tauri IPC (`invoke` commands).

The frontend is a single-page app in `src/` (`main.ts` + `styles.css`) served from `index.html`. The Rust backend lives in `src-tauri/src/` (`main.rs`, `lib.rs`, `rpc.rs`) and drives two runtime concerns directly:

- **HTTP requests / diagnostics**: `run_curl`, `dns_lookup`, `ping_host`, `tcp_check`, `traceroute_host`, `get_network_info`, `tls_inspect`, `import_pcap` — mostly shell out to `curl` / `ping` / `traceroute` / `ip` / `resolvectl`.
- **Downloads**: an embedded aria2c RPC client (`rpc.rs`, `Aria2Client`) talks to a locally-spawned `aria2c` process (`lib.rs`, `spawn_aria2` / `start_process_monitor`). curl-based one-off transfers are also supported (`add_curl`).

Downloads are confined to a managed download directory under the app data dir — see `resolve_managed_path` / `path_is_within` in `lib.rs`, which reject anything outside it and refuse symlinks/directories for deletion.

The agent chat (`agent_chat` command) spawns `node agent-runtime.mjs`, which runs the Claude Agent SDK as a read-only in-app assistant with Read/Glob/Grep plus three Aria-specific MCP tools. It never edits files or runs commands.

## Commands

From the repo root (Node + npm required; Rust toolchain for the Tauri side):

- `npm run dev` — start the Vite dev server on port 5173 (Tauri `devUrl`)
- `npm run build` — `tsc` type-check then `vite build` into `dist/` (consumed by Tauri as `frontendDist`)
- `npm run tauri` — Tauri CLI (build/run the desktop app)
- `cargo build` / `cargo check` — in `src-tauri/` for the Rust side

There is no test suite, no lint step beyond `tsc` strict mode, and no separate test runner. To exercise a change end-to-end, run `npm run build` then `npm run tauri`.

## Architecture notes

- `lib.rs` defines all command request/response structs (camelCase serde) and `AppState` (aria2 client, stop flag, managed root, curl download map). Its `Drop` kills running curl children.
- `rpc.rs` is the aria2 JSON-RPC client: `addUri`, `tellActive/Waiting/Stopped`, `tellStatus`, `getGlobalStat`, `pause/unpause/remove/forceRemove`, position/priority changes, global options.
- `main.rs` is a thin entry: `app_lib::run()`.
- Tauri config: `src-tauri/tauri.conf.json` (productName "Aria", `frontendDist: ../dist`, dev on localhost:5173, `beforeBuildCommand: npm run build`). Capabilities in `src-tauri/capabilities/default.json` grant `core:default` and `dialog:default` to the main window.
- `tsconfig.json` includes only `src`; strict mode on. Vite config sets `clearScreen: false`, port 5173 strict, env prefix `VITE_`/`TAURI_`.
- `index.html` wires up the UI tabs (Request Lab, Diagnostics, Transfers, History, Agent) and loads `/src/main.ts`.
- `agent-runtime.mjs` is the read-only agent runtime; it is invoked by the backend with `projectRoot` and `memoryPath` (defaults to `/data/leywin/Projects/aria` and `.../memory`).

Memory for the agent lives at `/home/leywin/.claude/projects/-data-leywin-Projects-aria/memory/MEMORY.md` — current direction: networking and authorized auditing take priority over downloads.

## Foreign configs

A codex config exists at `/home/leywin/.codex/config.toml` (user-level, not part of this repo). I have not read it. To scan what can be imported (MCP servers, slash commands, subagents, skills, instructions), reply `/import`. Then apply with `/import --yes=<digest>` using the digest the scan names. Do not ask me to read or apply the codex config directly — that import is a deterministic terminal action you control.
