# Electron

A Windows desktop app for chatting with every Claude model through the Anthropic API.

- Native Windows window (Electron), with an optional browser view at `http://localhost:4317` on the same PC.
- Pick any model the API returns, including the Claude 5 family (Fable, Opus, Sonnet, Haiku).
- Streaming replies, optional adaptive thinking, effort control, and a system prompt.
- Your API key is verified once, then stored encrypted with Windows DPAPI through Electron `safeStorage`.

## Run it

```powershell
npm install
npm start
```

Then paste your API key (starts with `sk-ant-`) into the sidebar and click **Verify & save**.

## Build a portable .exe

```powershell
npm run dist
```

The output is in `dist\`.

## Tests

```powershell
npm test
```

## Security model

- **Key storage:** the key is encrypted by `safeStorage` (Windows DPAPI) into `%APPDATA%\Electron\api-key.bin`. It can only be decrypted by your Windows user account on this machine. Copying the file elsewhere does not expose the key.
- **Key handling:** the key lives only in the Electron main process. The renderer and preload bridge never receive it. The UI shows only the last 4 characters. Error messages are sanitized.
- **Verification:** a new key is checked against the Models API before it is saved. Admin keys (`sk-ant-admin…`) are rejected.
- **Desktop IPC:** the preload bridge exposes a fixed set of functions. Only pages loaded from `file://` (the app itself) may call them.
- **Localhost access:** the optional local server binds to `127.0.0.1` only. It rejects any Host or Origin other than `localhost`/`127.0.0.1` (this blocks DNS-rebinding and cross-site requests), requires a random per-launch token on `/api/*`, and sends `no-store` and CSP headers.
  - To turn it off, set `CLAUDE_HUB_LOCAL=0` before starting.
  - To change the port, set `CLAUDE_HUB_PORT`.
- **Limits:** conversation size is capped, model IDs are validated, and request bodies are capped at 2 MB.
- **Limitation:** JavaScript cannot wipe strings from memory. The key is held in memory while the app runs.

## Project layout

```
main.js              Electron main process: window, IPC, key ownership
preload.cjs          Sandboxed bridge exposing a fixed API to the page
lib/hub.js           Core logic: key checks, model list, streaming chat
lib/key-store.js     safeStorage-encrypted key file
lib/models.js        Models API listing and offline fallback list
lib/local-server.js  Optional 127.0.0.1 web access with token + host checks
public/              UI (index.html, app.js, style.css)
test/                Unit tests (node:test)
```

## Notes

- Requires Windows 10/11 for DPAPI-backed storage. Electron `safeStorage` on other systems may use a different keychain, and the app refuses to save a key if no secure storage is available.
- Requires Node.js 20+ for development.
