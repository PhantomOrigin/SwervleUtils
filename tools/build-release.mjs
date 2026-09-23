#!/usr/bin/env node
// Builds both release zips from this one source tree:
//   versions/SwervleUtilsChromium.zip  Chrome / Edge / Brave (manifest.json as-is)
//   versions/SwervleUtilsFirefox.zip   Firefox (manifest derived from manifest.json)
//
// The Firefox manifest is GENERATED from manifest.json rather than kept as a
// second hand-edited file, so the two can never drift out of sync (version,
// permissions, content scripts all come from the one real manifest). The
// only differences are the ones Firefox actually requires:
//   - background: Firefox doesn't support `service_worker` (only a `scripts`
//     array — see Mozilla's MV3 migration guide), so the same file is
//     declared under `scripts` instead.
//   - browser_specific_settings.gecko: an add-on ID (required to sign/
//     publish), a minimum version (content_scripts `world: "MAIN"`, which
//     srv-main.js needs, is recent in Firefox — 128 is believed to be the
//     first version with it but that was not confirmed against Mozilla's
//     docs, so raise GECKO_MIN_VERSION if testing shows otherwise), and the
//     data-collection declaration AMO now asks new extensions to make
//     (older Firefox versions just ignore it).
// The Chrome build is byte-for-byte the repo's manifest.json — nothing here
// changes what Chrome users get.
//
// Zips are written by hand (no dependencies, and forward-slash paths on every
// OS — Windows PowerShell 5.1's Compress-Archive writes backslashes, which
// Firefox/AMO reject).
//
// Usage: node tools/build-release.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSIONS = join(ROOT, "versions");

// Changing this later would make Firefox treat the add-on as a different one
// (users would lose settings/storage and not get updates) — pick once.
const GECKO_ID = "swervle-utils@phantomorigin";
const GECKO_MIN_VERSION = "128.0";

function runtimeFiles(manifest) {
  const files = new Set();
  const bg = manifest.background ?? {};
  if (bg.service_worker) files.add(bg.service_worker);
  for (const s of bg.scripts ?? []) files.add(s);
  for (const cs of manifest.content_scripts ?? []) {
    for (const f of [...(cs.js ?? []), ...(cs.css ?? [])]) files.add(f);
  }
  for (const p of Object.values(manifest.icons ?? {})) files.add(p);
  const actionIcon = manifest.action?.default_icon;
  if (typeof actionIcon === "string") files.add(actionIcon);
  else for (const p of Object.values(actionIcon ?? {})) files.add(p);
  return [...files].sort();
}

function toFirefoxManifest(manifest) {
  const { service_worker, ...bgRest } = manifest.background ?? {};
  if (!service_worker) throw new Error("manifest.json has no background.service_worker to convert");
  return {
    ...manifest,
    background: { ...bgRest, scripts: [service_worker] },
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: GECKO_MIN_VERSION,
        data_collection_permissions: { required: ["none"] },
      },
    },
  };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

function collect(manifestBytes, manifest) {
  const entries = [{ name: "manifest.json", data: manifestBytes }];
  for (const f of runtimeFiles(manifest)) {
    const p = join(ROOT, f);
    if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`manifest references "${f}" but it doesn't exist`);
    entries.push({ name: f.replace(/\\/g, "/"), data: readFileSync(p) });
  }
  return entries;
}

function main() {
  const chromeBytes = readFileSync(join(ROOT, "manifest.json"));
  const chromeManifest = JSON.parse(chromeBytes.toString("utf8"));
  const firefoxManifest = toFirefoxManifest(chromeManifest);
  const firefoxBytes = Buffer.from(JSON.stringify(firefoxManifest, null, 2) + "\n", "utf8");

  mkdirSync(VERSIONS, { recursive: true });
  const builds = [
    ["SwervleUtilsChromium.zip", collect(chromeBytes, chromeManifest)],
    ["SwervleUtilsFirefox.zip", collect(firefoxBytes, firefoxManifest)],
  ];
  console.log(`Building v${chromeManifest.version}`);
  for (const [file, entries] of builds) {
    const zip = buildZip(entries);
    try {
      writeFileSync(join(VERSIONS, file), zip);
    } catch (err) {
      // Windows refuses to overwrite a zip another program has open — in
      // practice Firefox, which keeps a temporary add-on's zip locked for as
      // long as it's loaded in about:debugging.
      console.error(`  versions/${file}  NOT written (${err.code ?? err.message}) — is it still loaded as a temporary add-on in Firefox, or open in another program? Remove/close it and run this again.`);
      process.exitCode = 1;
      continue;
    }
    console.log(`  versions/${file}  (${entries.length} files, ${zip.length} bytes)`);
  }
}

main();
