# Aria Agent Instructions

Aria is a Tauri v2 desktop networking workbench and authorized auditing tool. The TypeScript/Vite single-page frontend communicates with a Rust backend through Tauri IPC. Networking diagnostics and HTTP requests are primary; aria2-backed downloads are secondary.

## Repository layout

- `src/main.ts` — frontend state, DOM rendering, event handlers, IPC calls, and tool views.
- `src/styles.css` — frontend styling.
- `index.html` — app shell and UI markup.
- `src-tauri/src/lib.rs` — Tauri commands, request/response structs, process management, download path safety, and app state.
- `src-tauri/src/rpc.rs` — async aria2 JSON-RPC client.
- `src-tauri/src/browser.rs` — headless Chrome/CDP process and page operations.
- `src-tauri/src/main.rs` — thin entry point calling `app_lib::run()`.
- `agent-runtime.mjs` — read-only Claude Agent SDK runtime for the embedded Agent view.
- `vite.config.ts`, `tsconfig.json`, `src-tauri/tauri.conf.json` — frontend, TypeScript, and Tauri configuration.

## Dev environment

- Node.js/npm are required for the frontend; Rust 1.90+ and Cargo are required for Tauri (`edition = "2024"`).
- Install JavaScript dependencies from the repository root using the checked-in `package-lock.json`.
- `aria2c` is started by the backend and must be available on PATH (or at `/usr/bin/aria2c`, `/usr/local/bin/aria2c`, or `/opt/homebrew/bin/aria2c`) for download features.
- Runtime diagnostics shell out to `curl`, `ping`, `traceroute`, `ip`, and `resolvectl` (with platform-specific fallbacks).
- The frontend dev server is fixed to `http://localhost:5173` and `strictPort` is enabled.
- Browser/CDP features use port `9222` and search for Chrome/Chromium, including `/usr/bin/google-chrome` and `/usr/bin/chromium`.

## Build and run

Run frontend commands from the repository root:

- `npm run dev` — start Vite on port 5173.
- `npm run build` — run strict TypeScript checking, then create the Vite build in `dist/`.
- `npm run tauri` — invoke the Tauri CLI.

Run Rust checks from `src-tauri/`:

- `cargo check`
- `cargo build`

Tauri configuration runs `npm run dev` before development and `npm run build` before a Tauri build. `dist/` is the configured `frontendDist`.

## Testing and linting

There is no test suite, test runner, or separate lint script in `package.json` or the repository configuration. `npm run build` is the frontend type-check/build verification; `cargo check` is the Rust compilation check.

## Code conventions

- TypeScript uses strict mode, ES2021, ES-module imports, bundler resolution, and `forceConsistentCasingInFileNames`.
- Frontend code is currently concentrated in `src/main.ts`; it uses typed interfaces, DOM helpers `$`/`$$`, explicit union types, and `invoke` for backend commands.
- Rust command payloads use `#[serde(rename_all = "camelCase")]` to match frontend objects. Tauri commands return `Result<..., String>` and map process, transport, parse, and validation failures to user-facing strings.
- Rust backend state is held in `AppState` using `Arc`, `Mutex`, and Tokio mutexes. `main.rs` should remain a thin launcher.
- Backend modules use snake_case names; frontend variables/functions use camelCase and types/interfaces use PascalCase.

## Pitfalls and safety boundaries

- Do not hand-edit `dist/`, `node_modules/`, or `src-tauri/target/`; they are generated outputs.
- Keep download paths within the managed app download directory. `resolve_managed_path`/`path_is_within` reject outside paths and deletion of symlinks/directories.
- `agent-runtime.mjs` is intentionally read-only: its Agent SDK tools are limited to Read/Glob/Grep and Aria observation tools; do not add file or shell mutation capabilities without an explicit security decision.
- `src-tauri/tauri.conf.json` expects the frontend build at `dist/`; stale or missing `dist/` can break Tauri startup/builds.
- Network diagnostics and downloads depend on external executables and services; errors such as `curl is unavailable`, `aria2c not found`, and RPC unavailable are runtime dependency failures, not TypeScript failures.
- Preserve the Tauri CSP and capability configuration when changing frontend/backend integration.
