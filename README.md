# Aria

Aria is a desktop networking workbench built with Tauri 2, TypeScript, Vite, and Rust. It combines HTTP request inspection, network diagnostics, traffic capture, endpoint discovery, report export, and aria2-powered transfers in one local application.

> Aria is intended for systems and services you own or are authorized to assess.

## What it includes

### Request Lab

- Compose and send `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS` requests.
- Configure headers, raw bodies, authentication, cookies, redirects, compression, TLS verification, IP family, proxy, timeout, certificate, and user-agent settings.
- Inspect status, response headers, formatted payloads, raw output, timing, effective URL, remote address, and curl exit status.
- Copy requests as cURL commands.

### Network Inspector

- Record application traffic and filter it by text, status, method, or resource type.
- Inspect request and response headers, payloads, timing, cookies, initiators, and previews.
- Replay captured requests and copy them as cURL or `fetch()`.
- Import/export HAR files.
- Cluster observed calls into endpoint patterns and export an OpenAPI 3.0 JSON document.

### Diagnostics

- DNS lookup with IPv4/IPv6 results.
- Ping, TCP connectivity, traceroute, route, and DNS configuration inspection.
- TLS handshake and certificate inspection.
- PCAP import and preview.

### Transfers

- Use a managed, locally spawned aria2c service for URI, torrent, and Metalink downloads.
- Use curl for one-off transfers.
- Pause, resume, remove, reorder, reprioritize, inspect, and purge transfers.
- Keep downloads inside Aria's managed application data directory.

### Agent

The embedded Agent view can use the Claude Agent SDK or an OpenAI-compatible HTTP endpoint. The local SDK runtime is intentionally read-only: it can inspect project files and supplied application context, but it cannot edit files, run shell commands, make network requests, or perform security testing actions.

## Requirements

- Node.js and npm
- Rust 1.90 or newer and Cargo
- Tauri 2 system dependencies for your platform
- `curl` for HTTP requests and curl transfers
- `aria2c` for managed downloads
- `ping`, `traceroute`, `ip`, and `resolvectl` for the corresponding Linux diagnostics
- Chrome or Chromium for the optional browser/CDP functionality

The backend searches common aria2c locations including PATH, `/usr/bin/aria2c`, `/usr/local/bin/aria2c`, and `/opt/homebrew/bin/aria2c`. Browser/CDP support uses port `9222`.

## Getting started

```bash
git clone https://github.com/leywin-coder/aria-gui.git
cd aria-gui
npm install
npm run tauri dev
```

The development frontend uses `http://localhost:5173`. The Tauri development command starts Vite automatically.

## Commands

From the repository root:

```bash
npm install          # install JavaScript dependencies
npm run dev          # start Vite on port 5173
npm run build        # strict TypeScript check and Vite production build
npm run tauri dev    # start the Tauri desktop application
```

For Rust checks:

```bash
cd src-tauri
cargo check
cargo test
```

There is currently no separate JavaScript test suite or lint script. `npm run build` runs TypeScript in strict mode before producing `dist/`. `cargo check` verifies the Rust backend and `cargo test` currently reports zero Rust tests.

## Architecture

```text
index.html + src/main.ts + src/styles.css
                 │
                 │ Tauri IPC invoke()
                 ▼
        src-tauri/src/lib.rs
          ├─ HTTP and diagnostics commands
          ├─ managed download lifecycle
          ├─ workspace and report persistence
          ├─ read-only agent runtime bridge
          └─ browser/CDP commands
                 │
                 ├─ src-tauri/src/rpc.rs   aria2 JSON-RPC client
                 ├─ src-tauri/src/browser.rs Chrome/CDP integration
                 └─ agent-runtime.mjs      Claude Agent SDK runtime
```

The frontend is a single-page TypeScript application. Rust owns process execution, filesystem operations, diagnostics, download state, and IPC command validation. Tauri configuration is in `src-tauri/tauri.conf.json`; capabilities are explicitly declared in `src-tauri/capabilities/default.json`.

## Data and security boundaries

- Download files are restricted to the managed download directory under the Tauri app data directory.
- Download deletion rejects paths outside that directory and refuses symlinks and directories.
- Workspace files are stored under the app data directory and validated against a schema version and size limits.
- Reports are limited to 4 MiB and support JSON, Markdown, and HTML output.
- The Tauri Content Security Policy is defined in `src-tauri/tauri.conf.json`; review it before changing frontend integrations.
- API keys and credentials should not be committed. Keep local environment files and secrets outside Git.

## Project layout

```text
src/                    TypeScript frontend and styles
src-tauri/src/lib.rs    Tauri commands and application state
src-tauri/src/rpc.rs    aria2 JSON-RPC client
src-tauri/src/browser.rs Chrome/CDP process support
agent-runtime.mjs       Read-only embedded agent runtime
index.html              Application shell
vite.config.ts          Vite configuration
src-tauri/              Rust/Tauri configuration and assets
```

## Status

Aria is under active development. The frontend and Rust backend compile successfully with the commands above, but the project does not yet ship a release artifact or automated end-to-end test suite.

## License

No project license has been declared yet.
