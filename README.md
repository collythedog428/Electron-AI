# Electron

A Windows desktop app for chatting with every Claude model through the Anthropic API.

- A native Windows window, with an optional browser view at `http://localhost:4317` on the same PC.
- Pick any model the API returns, including the Claude 5 family (Fable, Opus, Sonnet, Haiku).
- Streaming replies, optional adaptive thinking, effort control, and a system prompt.
- **Chat or Voice:** type in Chat, or use the Voice console to talk to Spark and hear the reply.
- **Spark**, an animated helper that reacts to what's happening, with a customisable outfit.
- **Speech to text** on this PC (Whisper), so audio never leaves your computer.
- **Attachments:** images, PDFs and text files.
- **Import and export** of chats, including ChatGPT and Claude exports.
- Your API key is verified once, then stored encrypted with Windows DPAPI.

## Install

You need Windows 10 or 11. Pick one of the options below.

### Option 1: Download the app (easiest)

1. Go to the [Releases page](https://github.com/collythedog428/Electron-AI/releases) and open the latest release.
2. Download the `.exe` attached to it (for example `Electron-1.0.0.exe`).
3. Double-click it to run. No installer is needed. You can move the file anywhere, for example to your Desktop.
4. If Windows warns about an unknown publisher, choose **More info**, then **Run anyway**.

> **Smart App Control:** the app is not signed with a code-signing certificate, so Windows Smart App Control may block it. Smart App Control has no per-app exception, so this option works only if Windows allows the file. If it's blocked, use Option 2.

### Option 2: Run from the source code

This needs **Git** and **Node.js 20 or newer**.

**1. Install Git and Node.js** (run in PowerShell; Windows 10/11 with `winget`):

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
```

Close PowerShell and open a new window afterwards, so the new commands are found. Check that both installed:

```powershell
git --version
node --version
npm --version
```

Node.js must show version 20 or higher. You can also download both from [git-scm.com](https://git-scm.com) and [nodejs.org](https://nodejs.org) instead.

**2. Download the code, install dependencies, and start the app:**

```powershell
git clone https://github.com/collythedog428/Electron-AI.git
cd Electron-AI
npm install
npm start
```

The app opens in its own window. To open it again later, run `npm start` from the same `Electron-AI` folder. To get the latest changes, run `git pull` in that folder first.

### Option 3: Build the .exe yourself

From the project folder:

```powershell
npm install
npm run dist
```

The finished file is in `dist\`, named `Electron 1.0.0.exe`. It's a single portable file. The build takes a few minutes.

## First launch

1. Enter your **name**.
2. Paste your **Anthropic API key** (it starts with `sk-ant-`). Create one in the Anthropic Console.
3. Click **Get started**.

The name is saved as soon as you enter it. The key is checked against the API before it's saved. After that, the app opens straight to your chats. Your name and key are kept in `%APPDATA%\Electron`, so they're still there next time.

To change the key, go to **Settings → API key**. To remove it, click **Remove stored key** there.

## Using the app

- **Chats:** use **+ New chat** in the sidebar. Click a chat to open it, or hover over it and click × to delete it. Deleting asks you to confirm first.
- **Voice:** click **🎙️ Voice** at the top of the sidebar. Tap **Tap to talk**, speak, then tap **⏹ Stop**. Your words are sent straight away, and the reply is read aloud. The sidebar folds to icons in this mode. Reading aloud can be turned off in **Settings → App behaviour**.
- **Speech to text:** in **Settings → Speech to text**, click **Download speech model** once (about 150 MB). After that, the 🎙️ button in the chat box dictates into the message box.
- **Attachments:** click 📎 to attach images (PNG, JPEG, GIF, WebP up to 5 MB), PDFs (up to 20 MB) or text files (up to 500 KB).
- **Chat data:** in **Settings → Chat data**, **Export chats** saves everything to one JSON file. **Import chats…** accepts an export, a zip of exports, or a ChatGPT or Claude data export. Imports add chats and never replace existing ones.
- **Spark:** the helper in the chat header reacts to what's happening. Click it to play. In **Settings → Spark's outfit**, pick a hat, a shirt colour and glasses, and see a preview. A setting turns Spark off.
- **Model and reply options:** in **Settings**, choose a model, turn on adaptive thinking, set the effort level, and write a system prompt.
- **Appearance:** in **Settings**, change the background, dot size and strength, accent colour, text size and animations. Use **Reset** to restore the defaults.
- **Keyboard:** press **Enter** to send and **Shift+Enter** for a new line. You can switch this in **Settings → App behaviour**.
- **Browser view:** while the app is open, go to `http://localhost:4317` in a browser on the same PC. It shares your name and key with the app, but its chats are kept separately.

## Troubleshooting

- **Windows blocks the app:** see the Smart App Control note under Option 1, or use Option 2.
- **"Could not unlock saved key":** the key was saved under a different Windows user account. Paste the key again in **Settings → API key**.
- **"Could not open port 4317":** another program is using that port. Close it and restart the app, or set `CLAUDE_HUB_PORT` to a different number.
- **Setup screen keeps appearing:** the key didn't save. Check that secure storage is available on your PC, then try again.
- **Speech says the model isn't installed:** download it in **Settings → Speech to text**. It needs an internet connection the first time.

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
- **Attachments:** only images, PDFs and text are accepted. Each block is checked for type, base64 data and size before anything is sent to Anthropic.
- **Speech:** the engine and model are downloaded from GitHub and Hugging Face over HTTPS, and audio is transcribed on this PC. Downloads are not checksum-verified yet.
- **Limits:** conversation size is capped, model IDs are validated, and request bodies are capped at 40 MB to allow for attachments.
- **Limitation:** JavaScript cannot wipe strings from memory. The key is held in memory while the app runs.
- **Chats, name and settings:** chats and appearance settings are stored in the app's local storage in `%APPDATA%\Electron`, and the name in `profile.json`. None of these are encrypted. Only the API key is.

## Project layout

```
main.js                   Electron main process: window, IPC, key ownership
preload.cjs               Sandboxed bridge exposing a fixed API to the page
lib/hub.js                Core logic: key checks, name, model list, streaming chat, attachment checks
lib/key-store.js          safeStorage-encrypted key file
lib/models.js             Models API listing and offline fallback list
lib/local-server.js       Optional 127.0.0.1 web access with token + host checks
lib/speech.js             Offline speech-to-text with whisper.cpp (download, record, transcribe)
public/index.html         The page: chat, voice console, settings and dialogs
public/app.js             Renderer logic: chats, settings, attachments, import and export, voice
public/mascot.js          Spark's moods, loading animations and idle moves
public/import-formats.js  Converters for ChatGPT and Claude exports
public/zip.js             Small zip reader for chat imports
public/style.css          Styles and animations
test/                     Unit tests (node:test)
```

## Building a release

Each release attaches the portable `.exe` built with `npm run dist` to a GitHub Release tagged `vX.Y.Z`.
