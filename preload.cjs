// Runs in the sandboxed preload context. Exposes a small, fixed API to the page.
// The API key never crosses this bridge: the page only gets status and model lists.
const { contextBridge, ipcRenderer } = require("electron");

const unwrap = (result) => {
  if (!result || !result.ok) throw new Error(result?.error || "Request failed.");
  return result.data;
};

contextBridge.exposeInMainWorld("claudeHub", {
  status: async () => unwrap(await ipcRenderer.invoke("hub:status")),
  saveKey: async (apiKey) => unwrap(await ipcRenderer.invoke("hub:saveKey", apiKey)),
  deleteKey: async () => unwrap(await ipcRenderer.invoke("hub:deleteKey")),
  setName: async (name) => unwrap(await ipcRenderer.invoke("hub:setName", name)),
  approve: async (id, allow) => unwrap(await ipcRenderer.invoke("hub:approve", id, allow)),
  models: async (force) => unwrap(await ipcRenderer.invoke("hub:models", Boolean(force))),
  chat: async (id, body) => unwrap(await ipcRenderer.invoke("hub:chat", id, body)),
  cancel: (id) => ipcRenderer.send("hub:cancel", id),
  onEvent: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("hub:event", listener);
    return () => ipcRenderer.removeListener("hub:event", listener);
  },
  localAccess: async () => unwrap(await ipcRenderer.invoke("app:localAccess")),
  speechStatus: async () => unwrap(await ipcRenderer.invoke("speech:status")),
  speechInstall: async () => unwrap(await ipcRenderer.invoke("speech:install")),
  speechTranscribe: async (wavBytes) => unwrap(await ipcRenderer.invoke("speech:transcribe", wavBytes)),
  onSpeechProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("speech:progress", listener);
    return () => ipcRenderer.removeListener("speech:progress", listener);
  },
});
