import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";

// zip.js is a browser script (no exports), so load its functions into this test.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, "..", "public", "zip.js"), "utf8");
const { readZipJsonFiles } = new Function(`${source}; return { readZipJsonFiles };`)();

// Builds a minimal zip archive: entries are [name, text, method] with method 0 (stored) or 8 (deflate).
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text, method] of entries) {
    const raw = Buffer.from(text, "utf8");
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBuf, end]));
}

test("reads deflated and stored JSON entries and ignores other files", async () => {
  const zip = buildZip([
    ["chats/one.json", '{"format":"electron-chats","chats":[]}', 8],
    ["two.json", "[]", 0],
    ["notes.txt", "not json", 8],
  ]);
  const files = await readZipJsonFiles(zip);
  assert.deepEqual(files.map((f) => f.name), ["chats/one.json", "two.json"]);
  assert.equal(files[0].text, '{"format":"electron-chats","chats":[]}');
  assert.equal(files[1].text, "[]");
});

test("refuses bytes that are not a zip", async () => {
  await assert.rejects(readZipJsonFiles(new Uint8Array(100)), /not a valid zip/);
});

test("skips entries that try to escape the archive", async () => {
  const zip = buildZip([
    ["../evil.json", "[]", 0],
    ["/abs.json", "[]", 0],
    ["ok.json", "[]", 0],
  ]);
  const files = await readZipJsonFiles(zip);
  assert.deepEqual(files.map((f) => f.name), ["ok.json"]);
});
