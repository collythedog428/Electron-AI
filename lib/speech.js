// Offline speech-to-text using whisper.cpp (runs entirely on this PC).
// The engine and the Whisper "base" model are downloaded once, on request, into
// the app's data folder. Audio never leaves the PC.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export const WHISPER_RELEASE = "b5907";
export const ENGINE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/whisper-bin-x64.zip`;
export const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const MODEL_FILE = "ggml-base.bin";
const MIN_MODEL_BYTES = 50 * 1024 * 1024; // the base model is about 148 MB
const MAX_AUDIO_BYTES = 30 * 1024 * 1024; // about 15 minutes of 16 kHz mono audio
const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000;

// Whisper prints tags such as [BLANK_AUDIO] or (music) for silence and noise. Remove them.
export function cleanTranscript(text) {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?:music|silence|noise|laughter|applause)\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeWav(bytes) {
  return (
    bytes.length > 44 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45 // "WAVE"
  );
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

export class SpeechService {
  /** @param {{ dir: string }} opts  dir = folder for the engine and model */
  constructor({ dir }) {
    this.dir = dir;
    this.busy = false;
    this.installing = false;
  }

  get binPath() {
    return path.join(this.dir, "bin", "Release", "whisper-cli.exe");
  }

  get modelPath() {
    return path.join(this.dir, "models", MODEL_FILE);
  }

  async exists(file) {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  }

  async status() {
    const engine = await this.exists(this.binPath);
    const model = await this.exists(this.modelPath);
    return {
      supported: process.platform === "win32",
      ready: engine && model,
      engine,
      model,
      installing: this.installing,
    };
  }

  /** Downloads the engine and model if missing. onProgress({ stage, percent }). */
  async install(onProgress = () => {}) {
    if (process.platform !== "win32") throw new Error("Speech-to-text is only set up for Windows.");
    if (this.installing) throw new Error("The speech model is already being installed.");
    this.installing = true;
    try {
      await mkdir(this.dir, { recursive: true });
      if (!(await this.exists(this.binPath))) {
        const zip = path.join(this.dir, "engine.zip");
        onProgress({ stage: "engine", percent: 0 });
        await this.download(ENGINE_URL, zip, (p) => onProgress({ stage: "engine", percent: p }), 1024 * 1024);
        await this.unzip(zip, path.join(this.dir, "bin"));
        await rm(zip, { force: true });
      }
      if (!(await this.exists(this.modelPath))) {
        await mkdir(path.dirname(this.modelPath), { recursive: true });
        onProgress({ stage: "model", percent: 0 });
        await this.download(MODEL_URL, this.modelPath, (p) => onProgress({ stage: "model", percent: p }), MIN_MODEL_BYTES);
      }
      onProgress({ stage: "done", percent: 100 });
      return this.status();
    } finally {
      this.installing = false;
    }
  }

  async download(url, dest, onProgress, minBytes) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}). Check your internet connection.`);
    const total = Number(res.headers.get("content-length")) || 0;
    const tmp = `${dest}.part`;
    let received = 0;
    let lastReported = -1;
    const counter = async function* (source) {
      for await (const chunk of source) {
        received += chunk.length;
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastReported) {
            lastReported = pct;
            onProgress(pct);
          }
        }
        yield chunk;
      }
    };
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmp));
    if (received < minBytes) {
      await rm(tmp, { force: true });
      throw new Error("The download was incomplete. Try again.");
    }
    await rename(tmp, dest);
    onProgress(100);
  }

  unzip(zip, destDir) {
    return new Promise((resolve, reject) => {
      const cmd = `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(destDir)} -Force`;
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("Could not unpack the speech engine."))));
    });
  }

  /** Transcribes 16 kHz mono 16-bit WAV bytes. Returns cleaned text. */
  async transcribe(bytes) {
    if (this.busy) throw new Error("Still transcribing the previous recording. Please wait.");
    if (!looksLikeWav(bytes)) throw new Error("That audio is not in the expected WAV format.");
    if (bytes.length > MAX_AUDIO_BYTES) throw new Error("That recording is too long. Keep it under 15 minutes.");
    const status = await this.status();
    if (!status.ready) throw new Error("Install the speech model in Settings first.");

    this.busy = true;
    const tmpDir = path.join(this.dir, "tmp");
    const wav = path.join(tmpDir, `${randomUUID()}.wav`);
    try {
      await mkdir(tmpDir, { recursive: true });
      await writeFile(wav, bytes);
      const text = await this.run(["-m", this.modelPath, "-f", wav, "-l", "auto", "-nt", "-np"]);
      return cleanTranscript(text);
    } finally {
      this.busy = false;
      await rm(wav, { force: true });
    }
  }

  run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binPath, args, { windowsHide: true, cwd: this.dir });
      let out = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Transcription took too long and was stopped."));
      }, TRANSCRIBE_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => (out += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`The speech engine stopped with an error (code ${code}).`));
      });
    });
  }
}
