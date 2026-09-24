/**
 * 最小 ZIP 归档写入器（仅 STORE，即不压缩——WAV 已在调用方各自编码，
 * 打包只是容器）。零依赖，可在浏览器主线程直接运行。
 *
 * 生成的结构：
 *   [local file header 1][file data 1] ... [local file header N][file data N]
 *   [central directory 1] ... [central directory N]
 *   [end of central directory record]
 *
 * 文件名按 UTF-8 写入并设置 language encoding flag（EFS, bit 11），
 * 因此中文等非 ASCII 章节标题可安全作为条目名。
 */

export interface ZipEntry {
  filename: string;
  data: Uint8Array;
}

/** IEEE CRC-32（与 ZIP 规范一致的标准多项式 0xEDB88320）。 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

/** 现在时间（或指定 Date）的 DOS 日期/时间，ZIP 时间戳为本地时区约定。 */
function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    day:
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

const VERSION_STORE = 20; // 2.0：解包 STORE 归档所需的最低版本

/**
 * 把若干条目打成单个 ZIP。条目名需由调用方保证唯一。
 * 条目数量 / 归档大小受 ZIP32 限制（uint16 条目数、uint32 偏移）。
 */
export function buildZip(entries: ZipEntry[], now: Date = new Date()): Uint8Array {
  if (entries.length === 0) throw new Error('没有可打包的条目。');
  if (entries.length > 0xffff) throw new Error('条目数量超出 ZIP 限制。');
  if (new Set(entries.map((e) => e.filename)).size !== entries.length) {
    throw new Error('ZIP 条目名存在重复。');
  }
  const { time: dosTime, day: dosDate } = dosDateTime(now);

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.filename);
    if (nameBytes.length > 0xffff) throw new Error(`文件名过长：${entry.filename}`);
    const data = entry.data;
    const crc = crc32(data);
    const size = data.length;
    if (size > 0xffffffff || offset > 0xffffffff) {
      throw new Error('归档大小超出 ZIP32 表示范围。');
    }

    const local = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(local);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, VERSION_STORE, true);
    lv.setUint16(6, 0x0800, true); // GP flag bit 11: UTF-8 names
    lv.setUint16(8, 0, true); // compression method: stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    new Uint8Array(local, 30).set(nameBytes);

    localParts.push(new Uint8Array(local), data);

    const central = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(central);
    cv.setUint32(0, 0x02014b50, true); // central file header signature
    cv.setUint16(4, 0x0314, true); // version made by (UNIX host, 2.0)
    cv.setUint16(6, VERSION_STORE, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); // stored
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    // external attrs: UNIX regular file with 0644 permission bits
    // (host in upper byte of version-made-byte is already UNIX=3),
    // otherwise strict unzip tools extract entries without read permission
    cv.setUint32(38, (0o100644 << 16) >>> 0, true);
    cv.setUint32(42, offset, true); // local header offset
    new Uint8Array(central, 46).set(nameBytes);
    centralParts.push(new Uint8Array(central));

    offset += local.byteLength + size;
  }

  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
  if (centralSize > 0xffffffff || offset > 0xffffffff) {
    throw new Error('归档大小超出 ZIP32 表示范围。');
  }
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // disk with central dir
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central dir offset
  ev.setUint16(20, 0, true); // comment length

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(new Uint8Array(eocd), pos);
  return out;
}
