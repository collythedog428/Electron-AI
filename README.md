# Electron

A Windows desktop app for chatting with every Claude model through the Anthropic API.

- Native Windows window, with an optional browser view at `http://localhost:4317` on the same PC.
- Pick any model the API returns, including the Claude 5 family (Fable, Opus, Sonnet, Haiku).
- Streaming replies, optional adaptive thinking, effort control, and a system prompt.
- Chats are kept in a sidebar, and you can customise the look in Settings.
- Your API key is verified once, then stored encrypted with Windows DPAPI.

## Install

You need Windows 10 or 11. Pick one of the options below.

### Option 1: Download the app (easiest)

1. Go to the [Releases page](https://github.com/collythedog428/Electron-AI/releases) and open the latest release.
2. Download `Electron-1.0.0.exe` (or the newest `.exe` in the release).
3. Double-click it to run. No installer is needed. You can move the file anywhere, for example to your Desktop.
4. If Windows warns about an unknown publisher, choose **More info**, then **Run anyway**.

> **Smart App Control:** the app is not signed with a code-signing certificate, so Windows Smart App Control may block it. Smart App Control has no per-app exception, so this option works only if Windows allows the file. If it's blocked, use Option 2.

### Option 2: Run from the source code

This needs Node.js 20 or newer ([nodejs.org](https://nodejs.org)).

```powershell
git clone https://github.com/collythedog428/Electron-AI.git
cd Electron-AI
npm install
npm start
```

The app opens in its own window. Run `npm start` from the same folder each time you want to open it.

### Option 3: Build the .exe yourself

From the project folder:

```powershell
npm install
npm run dist
```

The finished file is `dist\Electron 1.0.0.exe`. It's a single portable file. The build takes a few minutes.

## First launch

1. Enter your **name**.
2. Paste your **Anthropic API key** (it starts with `sk-ant-`). Create one in the Anthropic Console.
3. Click **Get started**.

The key is checked against the API before it's saved. After that, the app opens straight to your chats. Your name, key and chats are saved in `%APPDATA%\Electron`, so they're still there next time.

To change the key, go to **Settings → API key**. To remove it, click **Remove stored key** there.

## Using the app

- **Chats:** use **+ New chat** in the sidebar. Click a chat to open it, or hover over it and click × to delete it.
- **Model and reply options:** in **Settings**, choose a model, turn on adaptive thinking, set the effort level, and write a system prompt.
- **Appearance:** in **Settings**, change the background, dot size and strength, accent colour, text size and animations. Use **Reset** to restore the defaults.
- **Keyboard:** press **Enter** to send and **Shift+Enter** for a new line. You can switch this in **Settings → App behaviour**.
- **Browser view:** while the app is open, go to `http://localhost:4317` in a browser on the same PC.

## Troubleshooting

- **Windows blocks the app:** see the Smart App Control note under Option 1, or use Option 2.
- **"Could not unlock saved key":** the key was saved under a different Windows user account. Paste the key again in **Settings → API key**.
- **"Could not open port 4317":** another program is using that port. Close it and restart the app, or set `CLAUDE_HUB_PORT` to a different number.
- **Setup screen keeps appearing:** the name or key didn't save. Check that secure storage is available on your PC, then try again.

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
- **Chats and name:** these are stored in the app's local storage in `%APPDATA%\Electron`, not encrypted.

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

## Building a release

Each release attaches the portable `.exe` built with `npm run dist` to a GitHub Release tagged `vX.Y.Z`.
