import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SpeechService, cleanTranscript, looksLikeWav } from "../lib/speech.js";

function fakeWav(bytes = 100) {
  const b = new Uint8Array(44 + bytes);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  return b;
}

test("cleanTranscript removes Whisper noise tags and extra spaces", () => {
  assert.equal(cleanTranscript("  [BLANK_AUDIO]  Hello   there (music) "), "Hello there");
  assert.equal(cleanTranscript("[Music]"), "");
  assert.equal(cleanTranscript("Just words."), "Just words.");
});

test("looksLikeWav checks the RIFF/WAVE header", () => {
  assert.equal(looksLikeWav(fakeWav()), true);
  assert.equal(looksLikeWav(new Uint8Array(10)), false);
  const notWav = fakeWav();
  notWav[0] = 0x00;
  assert.equal(looksLikeWav(notWav), false);
});

test("transcribe refuses non-WAV data before running anything", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "speech-test-"));
  try {
    const svc = new SpeechService({ dir });
    await assert.rejects(svc.transcribe(new Uint8Array(200)), /WAV format/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transcribe asks for the model when it is not installed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "speech-test-"));
  try {
    const svc = new SpeechService({ dir });
    const s = await svc.status();
    assert.equal(s.ready, false);
    await assert.rejects(svc.transcribe(fakeWav()), /Install the speech model/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
