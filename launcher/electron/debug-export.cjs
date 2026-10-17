const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { exportSanitizedLogs } = require("./logging.cjs");

const MAX_ZIP32 = 0xffffffff;
const MAX_ENTRIES = 65535;

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | (Math.floor(date.getSeconds() / 2) & 31),
    date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31),
  };
}

function zipBuffer(entries) {
  if (entries.length > MAX_ENTRIES) throw new Error("Full debug bundle contains too many files for ZIP32");
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = zlib.deflateRawSync(raw, { level: 6 });
    if (raw.length > MAX_ZIP32 || compressed.length > MAX_ZIP32 || offset > MAX_ZIP32) {
      throw new Error("Full debug bundle is too large for ZIP32");
    }
    const crc = crc32(raw);
    const stamp = dosDateTime(entry.mtime || new Date());
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

function addFile(entries, sourcePath, archiveName) {
  const stat = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return;
  entries.push({ name: archiveName, data: fs.readFileSync(sourcePath), mtime: stat.mtime });
}

function addTree(entries, root, prefix) {
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return;
  const visit = (dir, relative) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      const next = relative ? path.join(relative, item.name) : item.name;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) visit(full, next);
      else if (item.isFile()) addFile(entries, full, path.posix.join(prefix, next.split(path.sep).join("/")));
      if (entries.length > MAX_ENTRIES) throw new Error("Full debug bundle contains too many files");
    }
  };
  visit(root, "");
}

function inside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function exportFullDebugBundle({ destinationPath, coreHome, launcherLogPath, launcherUserData, version, profile }) {
  const diagnosticsRoot = path.join(coreHome, "diagnostics");
  const launcherLogsRoot = path.dirname(launcherLogPath);
  if (inside(destinationPath, diagnosticsRoot) || inside(destinationPath, launcherLogsRoot)) {
    throw new Error("Choose an export destination outside the live diagnostics/log directories");
  }

  const tempSafe = path.join(os.tmpdir(), `codex-web-gpt-safe-${process.pid}-${Date.now()}.jsonl`);
  try {
    const safeRecordCount = exportSanitizedLogs({ filePath: launcherLogPath, destinationPath: tempSafe });
    const entries = [{
      name: "manifest.json",
      data: Buffer.from(JSON.stringify({
        format: "codex-web-gpt-full-debug-v1",
        createdAt: new Date().toISOString(),
        version,
        profile,
        warning: "This full debug bundle can contain browser screenshots, rendered UI state, local paths, and raw diagnostic details. Review it before sharing.",
        safeRecordCount,
      }, null, 2) + "\n"),
    }];
    addFile(entries, tempSafe, "safe/codex-web-gpt-diagnostics.jsonl");
    addFile(entries, launcherLogPath, "launcher/raw/launcher.jsonl");
    addFile(entries, `${launcherLogPath}.1`, "launcher/raw/launcher.jsonl.1");
    addFile(entries, path.join(launcherUserData, "logs", "process-stream-errors.log"), "launcher/raw/process-stream-errors.log");
    addTree(entries, diagnosticsRoot, "core/diagnostics");

    const archive = zipBuffer(entries);
    const destination = path.resolve(destinationPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, archive, { mode: 0o600 });
    try {
      fs.rmSync(destination, { force: true });
      fs.renameSync(temp, destination);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
    return { fileCount: entries.length, byteCount: archive.length, safeRecordCount };
  } finally {
    fs.rmSync(tempSafe, { force: true });
  }
}

module.exports = { exportFullDebugBundle, zipBuffer };
