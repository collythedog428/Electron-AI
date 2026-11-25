// A small zip reader for chat imports. It reads stored and deflated entries using the
// browser's built-in DecompressionStream, so no extra library is needed.
const ZIP_MAX_BYTES = 50 * 1024 * 1024; // total unpacked size allowed
const ZIP_MAX_ENTRIES = 500;

// Returns [{ name, text }] for every .json file in the zip. Other files are ignored.
async function readZipJsonFiles(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => view.getUint16(o, true);
  const u32 = (o) => view.getUint32(o, true);

  // The end-of-central-directory record sits at the end of the file (before any comment).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("That file is not a valid zip archive.");

  const count = u16(eocd + 10);
  if (count > ZIP_MAX_ENTRIES) throw new Error("That zip contains too many files.");
  let p = u32(eocd + 16); // offset of the central directory

  const decoder = new TextDecoder();
  const files = [];
  let unpacked = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || u32(p) !== 0x02014b50) throw new Error("That zip archive is damaged.");
    const method = u16(p + 10);
    const compressedSize = u32(p + 20);
    const size = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localOffset = u32(p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // Skip folders, macOS metadata and anything trying to escape the archive.
    const unsafe = name.startsWith("/") || name.includes("..") || name.includes("__MACOSX");
    if (unsafe || name.endsWith("/") || !name.toLowerCase().endsWith(".json")) continue;

    unpacked += size;
    if (unpacked > ZIP_MAX_BYTES) throw new Error("That zip is too large once unpacked.");

    if (localOffset + 30 > bytes.length || u32(localOffset) !== 0x04034b50) {
      throw new Error("That zip archive is damaged.");
    }
    const start = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
    const raw = bytes.subarray(start, start + compressedSize);

    let data;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error("That zip uses a compression method this app can't read.");
    }
    if (data.length !== size) throw new Error("That zip archive is damaged.");
    files.push({ name, text: decoder.decode(data) });
  }
  return files;
}
