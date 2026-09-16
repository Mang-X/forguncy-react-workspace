#!/usr/bin/env node
// 跨平台打包标准 ZIP：根目录只含 manifest.json / bundle.js / types.d.ts，并校验大小与 SHA-256。
// 用法: node pack_package.mjs [--dist dist] [--out ./<id>-<version>.zip]
// 归档时间戳固定为 1980-01-01，保证同样的输入得到同样的 ZIP 字节。
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const dist = path.resolve(argValue("--dist", "dist"));
const requiredNames = ["bundle.js", "manifest.json", "types.d.ts"];

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

const DOS_DATE = 0x0021; // 1980-01-01
const DOS_TIME = 0x0000;

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 9 });
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentral = Buffer.alloc(22);
  endOfCentral.writeUInt32LE(0x06054b50, 0);
  endOfCentral.writeUInt16LE(entries.length, 8);
  endOfCentral.writeUInt16LE(entries.length, 10);
  endOfCentral.writeUInt32LE(centralDirectory.length, 12);
  endOfCentral.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, endOfCentral]);
}

const failures = [];
const files = [];
for (const name of requiredNames) {
  const filePath = path.join(dist, name);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("不是文件");
    files.push({ name, data: await readFile(filePath) });
  } catch (error) {
    failures.push("缺少标准文件 " + filePath);
  }
}
if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

const manifest = JSON.parse(files.find(file => file.name === "manifest.json").data.toString("utf8"));
const archive = buildZip(files);
const uncompressedBytes = files.reduce((sum, file) => sum + file.data.length, 0);

const problems = [];
const maxZip = 16 * 1024 * 1024;
if (archive.length > maxZip) problems.push("ZIP 超过 16 MiB");
if (uncompressedBytes > maxZip) problems.push("解压后内容超过 16 MiB");
if (files.length > 20) problems.push("ZIP 条目超过 20");
const entryNames = files.map(file => file.name).sort().join(",");
if (entryNames !== "bundle.js,manifest.json,types.d.ts") problems.push("ZIP 根目录条目非法: " + entryNames);

const defaultOut = path.join(dist, "..", manifest.id + "-" + manifest.version + ".zip");
const outPath = path.resolve(argValue("--out", defaultOut));
await writeFile(outPath, archive);

const sha256 = value => createHash("sha256").update(value).digest("hex").toUpperCase();
const report = {
  ok: problems.length === 0,
  zipPath: outPath,
  zipBytes: archive.length,
  uncompressedBytes,
  entries: files.map(file => ({ name: file.name, bytes: file.data.length })),
  id: manifest.id,
  version: manifest.version,
  globalName: manifest.globalName,
  zipSha256: sha256(archive),
  problems
};
console.log(JSON.stringify(report, null, 2));
if (problems.length) process.exit(1);

