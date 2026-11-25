// Tools Spark can use on this computer: files, screen and mouse/keyboard.
// Each tool belongs to one "power" that the user turns on in Settings. Mouse and keyboard
// use PowerShell + Windows input APIs; text is passed through stdin, never built into the script.
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_READ_BYTES = 2 * 1024 * 1024;
export const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;

// The tool definitions sent to Claude, grouped by power.
export const TOOL_DEFS = [
  {
    name: "list_directory",
    power: "files_read",
    description: "List the files and folders in a directory on the user's computer.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, e.g. C:\\Users\\Name\\Documents" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    power: "files_read",
    description: "Read a text file on the user's computer (up to 2 MB).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path to the file" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    power: "files_write",
    description: "Create or overwrite a text file on the user's computer. Creates folders as needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to write" },
        content: { type: "string", description: "The full text content of the file" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "take_screenshot",
    power: "screen",
    description: "Take a screenshot of the user's screen so you can see what is shown.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mouse_click",
    power: "control",
    description: "Move the mouse to screen coordinates (x, y) and click. Take a screenshot first to find the right spot.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: 0, maximum: 20000 },
        y: { type: "integer", minimum: 0, maximum: 20000 },
        button: { type: "string", enum: ["left", "right", "double"] },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    power: "control",
    description: "Type text into whatever has keyboard focus.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 2000 } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "press_keys",
    power: "control",
    description: "Press a key or key combination, e.g. \"enter\", \"tab\", \"esc\", \"ctrl+s\", \"ctrl+shift+t\".",
    input_schema: {
      type: "object",
      properties: { keys: { type: "string", maxLength: 40 } },
      required: ["keys"],
      additionalProperties: false,
    },
  },
];

export const toolsForPowers = (powers) => TOOL_DEFS.filter((t) => powers[t.power]);

// --- Pure helpers (tested) ---------------------------------------------------

// Escapes text for SendKeys so every character is typed literally.
export function sendKeysEscape(text) {
  return [...text]
    .map((ch) => {
      if ("+^%~(){}[]".includes(ch)) return `{${ch}}`;
      return ch;
    })
    .join("");
}

const KEY_NAMES = {
  enter: "{ENTER}", return: "{ENTER}", tab: "{TAB}", esc: "{ESC}", escape: "{ESC}",
  backspace: "{BS}", delete: "{DEL}", del: "{DEL}", home: "{HOME}", end: "{END}",
  pageup: "{PGUP}", pagedown: "{PGDN}", up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
  space: " ", f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}", f6: "{F6}",
  f7: "{F7}", f8: "{F8}", f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}",
};
const MODIFIERS = { ctrl: "^", control: "^", shift: "+", alt: "%" };

// Turns "ctrl+shift+t" into SendKeys syntax. Only known names are accepted.
export function keyComboToSendKeys(combo) {
  const parts = String(combo).toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) throw new Error("Give one key or a short combination, like ctrl+s.");
  const last = parts.pop();
  let prefix = "";
  for (const m of parts) {
    if (!MODIFIERS[m]) throw new Error(`Unknown modifier "${m}". Use ctrl, shift or alt.`);
    prefix += MODIFIERS[m];
  }
  let key;
  if (KEY_NAMES[last] !== undefined) key = KEY_NAMES[last];
  else if (/^[a-z0-9]$/.test(last)) key = last;
  else throw new Error(`Unknown key "${last}".`);
  if (prefix && key.length > 1 && !key.startsWith("{")) throw new Error("Use a letter or number with a modifier.");
  return prefix ? `${prefix}(${key})` : key;
}

export function clampCoordinate(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 20000) throw new Error("Coordinates must be between 0 and 20000.");
  return n;
}

// --- Windows input helpers ---------------------------------------------------

const NATIVE_INPUT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NativeInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
}
"@
`;

function runPowerShell(script, stdin = "") {
  if (process.platform !== "win32") throw new Error("Mouse and keyboard control only works on Windows.");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error("The computer control step failed."))));
    child.stdin.end(stdin);
  });
}

async function clickAt(x, y, button) {
  const down = button === "right" ? "0x0008" : "0x0002";
  const up = button === "right" ? "0x0010" : "0x0004";
  const clicks = button === "double" ? 2 : 1;
  const once = `[NativeInput]::mouse_event(${down},0,0,0,[IntPtr]::Zero); [NativeInput]::mouse_event(${up},0,0,0,[IntPtr]::Zero);`;
  await runPowerShell(`${NATIVE_INPUT}\n[NativeInput]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 80; ${Array(clicks).fill(once).join(" Start-Sleep -Milliseconds 60; ")}`);
}

// --- Executors ---------------------------------------------------------------

// `captureScreen` returns a PNG as a Buffer (provided by the main process, which owns Electron).
export function createToolExecutor({ captureScreen }) {
  return async function execute(name, input) {
    switch (name) {
      case "list_directory": {
        const dir = path.resolve(String(input.path));
        const entries = await readdir(dir, { withFileTypes: true });
        const list = entries.slice(0, MAX_LIST_ENTRIES).map((e) => ({ name: e.name, type: e.isDirectory() ? "folder" : "file" }));
        return { text: JSON.stringify({ path: dir, entries: list, truncated: entries.length > MAX_LIST_ENTRIES }) };
      }
      case "read_file": {
        const file = path.resolve(String(input.path));
        const info = await stat(file);
        if (!info.isFile()) throw new Error("That path is not a file.");
        if (info.size > MAX_READ_BYTES) throw new Error("That file is larger than 2 MB.");
        return { text: await readFile(file, "utf8") };
      }
      case "write_file": {
        const file = path.resolve(String(input.path));
        const content = String(input.content ?? "");
        if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) throw new Error("The content is larger than 5 MB.");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content, "utf8");
        return { text: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${file}.` };
      }
      case "take_screenshot": {
        const png = await captureScreen();
        return { image: png.toString("base64"), text: "Screenshot of the user's screen." };
      }
      case "mouse_click": {
        const x = clampCoordinate(input.x);
        const y = clampCoordinate(input.y);
        const button = ["left", "right", "double"].includes(input.button) ? input.button : "left";
        await clickAt(x, y, button);
        return { text: `Clicked ${button} at ${x}, ${y}.` };
      }
      case "type_text": {
        const text = String(input.text ?? "");
        if (text.length > 2000) throw new Error("That text is too long to type at once.");
        // The text arrives on stdin and is escaped, so it can never change the script.
        await runPowerShell(
          `Add-Type -AssemblyName System.Windows.Forms\n$t = [Console]::In.ReadToEnd()\n[System.Windows.Forms.SendKeys]::SendWait($t)`,
          sendKeysEscape(text),
        );
        return { text: `Typed ${text.length} characters.` };
      }
      case "press_keys": {
        const keys = keyComboToSendKeys(input.keys);
        await runPowerShell(
          `Add-Type -AssemblyName System.Windows.Forms\n$k = [Console]::In.ReadToEnd()\n[System.Windows.Forms.SendKeys]::SendWait($k)`,
          keys,
        );
        return { text: `Pressed ${input.keys}.` };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}
