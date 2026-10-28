import { type FileHandle, open } from 'fs/promises';
import { inflateRawSync } from 'zlib';

// Reads one entry of a zip archive, such as a JDK src.zip or a -sources.jar. Zip64 archives,
// encrypted entries and methods other than stored and deflated are not read.

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
const STORED = 0;
const DEFLATED = 8;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

interface CentralEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function centralDirectory(file: FileHandle): Promise<CentralEntry[] | null> {
  const { size } = await file.stat();
  const tailLength = Math.min(size, END_SIZE + MAX_COMMENT);
  const tail = await readAt(file, size - tailLength, tailLength);
  let end = -1;
  for (let at = tail.length - END_SIZE; at >= 0; at--) {
    if (tail.readUInt32LE(at) === END_SIGNATURE) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  const count = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    return null;
  }
  const directory = await readAt(file, directoryOffset, directorySize);
  const entries: CentralEntry[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + CENTRAL_SIZE > directory.length) return null;
    if (directory.readUInt32LE(pos) !== CENTRAL_SIGNATURE) return null;
    const nameLength = directory.readUInt16LE(pos + 28);
    const extraLength = directory.readUInt16LE(pos + 30);
    const commentLength = directory.readUInt16LE(pos + 32);
    entries.push({
      name: directory.toString('utf8', pos + CENTRAL_SIZE, pos + CENTRAL_SIZE + nameLength),
      flags: directory.readUInt16LE(pos + 8),
      method: directory.readUInt16LE(pos + 10),
      compressedSize: directory.readUInt32LE(pos + 20),
      size: directory.readUInt32LE(pos + 24),
      localOffset: directory.readUInt32LE(pos + 42),
    });
    pos += CENTRAL_SIZE + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function entryContent(file: FileHandle, entry: CentralEntry): Promise<Buffer | null> {
  if ((entry.flags & 1) !== 0 || entry.size > MAX_ENTRY_BYTES) return null;
  const local = await readAt(file, entry.localOffset, LOCAL_SIZE);
  if (local.length < LOCAL_SIZE || local.readUInt32LE(0) !== LOCAL_SIGNATURE) return null;
  const dataOffset =
    entry.localOffset + LOCAL_SIZE + local.readUInt16LE(26) + local.readUInt16LE(28);
  const data = await readAt(file, dataOffset, entry.compressedSize);
  if (data.length < entry.compressedSize) return null;
  if (entry.method === STORED) return data;
  if (entry.method !== DEFLATED) return null;
  return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
}

export async function readZipEntry(
  path: string,
  pick: (names: string[]) => string | undefined,
): Promise<{ name: string; content: Buffer } | null> {
  let file: FileHandle;
  try {
    file = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const entries = await centralDirectory(file);
    if (!entries) return null;
    const name = pick(entries.map((entry) => entry.name));
    const entry = entries.find((candidate) => candidate.name === name);
    if (name === undefined || !entry) return null;
    const content = await entryContent(file, entry);
    return content ? { name, content } : null;
  } catch {
    return null;
  } finally {
    await file.close();
  }
}
