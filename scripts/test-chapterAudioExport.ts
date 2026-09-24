import {
  chapterSampleRange,
  encodePcm16Wav,
  timeToSample,
} from '../src/audio/wav';
import { crc32 } from '../src/audio/zip';
import {
  ChapterAudioExportError,
  buildChapterAudioPackage,
  buildEntryName,
  chapterPackageZipName,
  safeFileStem,
} from '../src/utils/chapterAudioExport';
import type { AudioBufferLike, Chapter } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) {
    console.log(`ok ${msg}`);
  } else {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)})`);
}
function throws(fn: () => void, msg: string, messageIncludes?: string) {
  try {
    fn();
    failures++;
    console.error(`FAIL ${msg}: expected throw`);
  } catch (err) {
    const okType = err instanceof ChapterAudioExportError;
    const okText =
      messageIncludes === undefined ||
      (err instanceof Error && err.message.includes(messageIncludes));
    check(okType && okText, `${msg} (got ${err instanceof Error ? err.message : err})`);
  }
}

const mk = (id: string, start: number, end: number, title = id): Chapter => ({
  id,
  title,
  start,
  end,
});

function fakeBuffer(channelData: Float32Array[], sampleRate: number): AudioBufferLike {
  return {
    duration: channelData[0].length / sampleRate,
    length: channelData[0].length,
    sampleRate,
    numberOfChannels: channelData.length,
    getChannelData: (c) => channelData[c],
  };
}

// ---------- 时间 → 采样：钳制 + 左闭右开 ----------
{
  eq(timeToSample(0, 1000, 2000), 0, 'timeToSample 0');
  eq(timeToSample(1, 1000, 2000), 1000, 'timeToSample 1s');
  eq(timeToSample(2, 1000, 2000), 2000, 'timeToSample end allowed == length');
  eq(timeToSample(-3, 1000, 2000), 0, 'timeToSample clamps negative');
  eq(timeToSample(99, 1000, 2000), 2000, 'timeToSample clamps past end');
  eq(timeToSample(0.0004, 1000, 2000), 0, 'timeToSample rounds 0.4 samples');
  eq(timeToSample(0.0006, 1000, 2000), 1, 'timeToSample rounds 0.6 samples');

  eq(chapterSampleRange(0, 1, 1000, 2000), { startSample: 0, endSample: 1000 }, 'range [0,1)');
  eq(chapterSampleRange(-0.5, 0.5, 1000, 2000), { startSample: 0, endSample: 500 }, 'range clamps start');
  eq(chapterSampleRange(1.5, 9, 1000, 2000), { startSample: 1500, endSample: 2000 }, 'range clamps end');
  check(chapterSampleRange(0, 0, 1000, 2000) === null, 'zero-length range is null');
  check(chapterSampleRange(-2, -1, 1000, 2000) === null, 'fully-negative range is null after clamp');
  // 边界四舍五入后重合（end<=start）也算无效
  check(chapterSampleRange(0.0004, 0.0004, 1000, 2000) === null, 'rounded-to-same-point is null');
  check(chapterSampleRange(1, 2, 0, 2000) === null, 'bad sample rate is null');
}

// ---------- 相邻章节：左闭右开，不重复不漏采样 ----------
{
  const a = chapterSampleRange(0, 1, 1000, 3000)!;
  const b = chapterSampleRange(1, 2, 1000, 3000)!;
  const c = chapterSampleRange(2, 3, 1000, 3000)!;
  check(a.endSample === b.startSample && b.endSample === c.startSample, 'adjacent ranges share one boundary index');
  check(a.startSample === 0 && c.endSample === 3000, 'tiling covers full extent');
  const covered =
    a.endSample - a.startSample + (b.endSample - b.startSample) + (c.endSample - c.startSample);
  eq(covered, 3000, 'tiled samples total == total samples (no dup, no gap)');
}

// ---------- WAV 编码：16-bit PCM / 小端 / 多声道交错 ----------
{
  const wav = encodePcm16Wav(48000, [
    new Float32Array([0, 0.5, 1, -1, 2, -2]),
    new Float32Array([-0.5, 0.25, -0.25, 0, NaN, 0.1]),
  ]);
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const sig = (o: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => dv.getUint8(o + i)));
  eq(sig(0), 'RIFF', 'wav RIFF signature');
  eq(sig(8), 'WAVE', 'wav WAVE signature');
  eq(sig(12), 'fmt ', 'wav fmt chunk');
  eq(dv.getUint16(20, true), 1, 'wav PCM format');
  eq(dv.getUint16(22, true), 2, 'wav preserves 2 channels');
  eq(dv.getUint32(24, true), 48000, 'wav preserves sample rate');
  eq(dv.getUint32(28, true), 48000 * 2 * 2, 'wav byte rate');
  eq(dv.getUint16(32, true), 4, 'wav block align');
  eq(dv.getUint16(34, true), 16, 'wav 16 bits');
  eq(sig(36), 'data', 'wav data chunk');
  eq(dv.getUint32(40, true), 6 * 2 * 2, 'wav data size');
  eq(dv.getUint32(4, true), 36 + 6 * 2 * 2, 'wav RIFF size');
  eq(wav.length, 44 + 24, 'wav total length');
  // interleaved L/R little-endian int16
  const s = (i: number) => dv.getInt16(44 + i * 2, true);
  eq([s(0), s(1), s(2), s(3), s(4), s(5), s(6), s(7), s(8), s(9), s(10), s(11)],
    [0, Math.round(-0.5 * 32767), Math.round(0.5 * 32767), Math.round(0.25 * 32767),
      32767, Math.round(-0.25 * 32767), -32767, 0, 32767, -32767, -32767, Math.round(0.1 * 32767)],
    'wav interleaved quantized samples (clamp + NaN)');
}

{
  // invalid encode inputs
  let threw = false;
  try { encodePcm16Wav(44100, []); } catch { threw = true; }
  check(threw, 'encode rejects no channels');
  threw = false;
  try { encodePcm16Wav(44100, [new Float32Array(0)]); } catch { threw = true; }
  check(threw, 'encode rejects empty segment');
  threw = false;
  try { encodePcm16Wav(44100, [new Float32Array(3), new Float32Array(2)]); } catch { threw = true; }
  check(threw, 'encode rejects mismatched channel lengths');
}

// ---------- CRC32 基本向量 ----------
{
  eq(crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'crc32 check vector');
  eq(crc32(new Uint8Array(0)), 0, 'crc32 empty = 0');
}

// ---------- 文件名安全化 ----------
{
  eq(safeFileStem('正常 标题 99'), '正常 标题 99', 'stem keeps CJK and spaces');
  eq(safeFileStem('a/b\\c:d*e?f|g<h>i"j'), 'a_b_c_d_e_f_g_h_i_j', 'stem replaces illegal chars');
  eq(safeFileStem('   '), 'chapter', 'blank title falls back');
  eq(safeFileStem(''), 'chapter', 'empty title falls back');
  eq(safeFileStem('trailing dots...'), 'trailing dots', 'stem strips trailing dots');
  eq(safeFileStem('CON'), '_CON', 'stem escapes DOS device name');
  eq(safeFileStem('x'.repeat(200)).length <= 80, true, 'stem caps length');
  eq(buildEntryName(1, 3, '开场'), '01-开场.wav', 'entry name zero-pads by total');
  eq(buildEntryName(123, 200, 'x'), '123-x.wav', 'entry name widens for totals');
  check(chapterPackageZipName('show ep.1') === 'show ep.1-chapters.zip', 'zip package name');
}

// ---------- 整包：排序、序号、裁剪跳过、真实 PCM 拼接还原 ----------
{
  const sr = 1000;
  const n = 3000;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = i / n;
    right[i] = -i / n;
  }
  const buffer = fakeBuffer([left, right], sr);

  // 乱序输入；含零时长 / 完全越界章节
  const chapters = [
    mk('mid', 1, 2, '第二章'),
    mk('end', 2, 9, '越界结尾'),
    mk('zero', 5, 5, '零时长'),
    mk('neg', -2, -1, '完全越界'),
    mk('start', -0.5, 1, '第一章/开场:序'),
  ];
  const pkg = buildChapterAudioPackage(buffer, chapters, new Date(2024, 0, 1, 12, 30, 30));
  eq(pkg.segments.length, 3, 'package has 3 valid segments');
  eq(pkg.skipped, 2, 'package skips 2 invalid chapters');
  eq(pkg.segments.map((s) => s.chapter.id), ['start', 'mid', 'end'], 'segments sorted by time');
  eq(
    pkg.segments.map((s) => s.filename),
    ['01-第一章_开场_序.wav', '02-第二章.wav', '03-越界结尾.wav'],
    'segment filenames numbered + sanitized',
  );
  eq(
    [pkg.segments[0].startSample, pkg.segments[0].endSample],
    [0, 1000],
    'first segment clamped to sample 0',
  );
  eq(
    [pkg.segments[2].startSample, pkg.segments[2].endSample],
    [2000, 3000],
    'last segment clamped to buffer length',
  );

  // 三个片段的 PCM 按序拼接应与原声道完全一致（左闭右开、无重无漏）
  const pcm: Int16Array[] = [];
  for (const seg of pkg.segments) {
    const dv = new DataView(seg.wav.buffer, seg.wav.byteOffset, seg.wav.byteLength);
    const frames = (seg.wav.length - 44) / 4;
    const ch = new Int16Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = dv.getInt16(44 + i * 4, true); // left channel
    pcm.push(ch);
  }
  const all = new Int16Array(n);
  let p = 0;
  for (const ch of pcm) { all.set(ch, p); p += ch.length; }
  let mismatch = 0;
  for (let i = 0; i < n; i++) {
    if (all[i] !== Math.round(left[i] * 32767)) mismatch++;
  }
  eq(mismatch, 0, 'concatenated segment PCM reconstructs original channel exactly');

  // ---------- 解析 ZIP 结构 ----------
  const zip = pkg.zip;
  const zdv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // find EOCD
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zdv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  check(eocd >= 0, 'zip has EOCD');
  const count = zdv.getUint16(eocd + 10, true);
  const centralSize = zdv.getUint32(eocd + 12, true);
  let centralOff = zdv.getUint32(eocd + 16, true);
  eq(count, 3, 'zip entry count');
  check(eocd === centralOff + centralSize, 'zip central directory layout');

  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    check(zdv.getUint32(centralOff, true) === 0x02014b50, `zip central signature ${i}`);
    const flag = zdv.getUint16(centralOff + 8, true);
    const method = zdv.getUint16(centralOff + 10, true);
    const crc = zdv.getUint32(centralOff + 16, true);
    const compSize = zdv.getUint32(centralOff + 20, true);
    const uncompSize = zdv.getUint32(centralOff + 24, true);
    const nameLen = zdv.getUint16(centralOff + 28, true);
    const extraLen = zdv.getUint16(centralOff + 30, true);
    const commentLen = zdv.getUint16(centralOff + 32, true);
    const localOff = zdv.getUint32(centralOff + 42, true);
    const name = decoder.decode(zip.subarray(centralOff + 46, centralOff + 46 + nameLen));
    eq(method, 0, `zip entry ${i} stored`);
    check((flag & 0x0800) !== 0, `zip entry ${i} UTF-8 name flag (${name})`);
    eq(compSize, uncompSize, `zip entry ${i} sizes equal`);
    // follow to local header and extract data
    const localNameLen = zdv.getUint16(localOff + 26, true);
    const localExtraLen = zdv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const data = zip.subarray(dataStart, dataStart + uncompSize);
    eq(crc32(data), crc, `zip entry ${i} crc matches data (${name})`);
    check(
      pkg.segments[i].filename === name &&
        data.length === pkg.segments[i].wav.length &&
        data.every((b, k) => b === pkg.segments[i].wav[k]),
      `zip entry ${i} name/data matches segment (${name})`,
    );
    centralOff += 46 + nameLen + extraLen + commentLen;
  }
}

// ---------- 无有效片段 / 编码失败：抛错，不产出任何可下载内容 ----------
{
  const buffer = fakeBuffer([new Float32Array(100)], 100);
  throws(() => buildChapterAudioPackage(buffer, []), 'no chapters throws');
  throws(
    () => buildChapterAudioPackage(buffer, [mk('a', -9, -8), mk('b', 3, 3)]),
    'all chapters invalid throws',
    '没有可导出',
  );
  throws(() => buildChapterAudioPackage(null as unknown as AudioBufferLike, []), 'no buffer throws');

  // 编码阶段失败（取声道数据抛错）→ 整条导出中止
  const broken: AudioBufferLike = {
    duration: 1,
    length: 100,
    sampleRate: 100,
    numberOfChannels: 2,
    getChannelData: (c) => {
      if (c === 1) throw new Error('channel unavailable');
      return new Float32Array(100);
    },
  };
  throws(
    () => buildChapterAudioPackage(broken, [mk('a', 0, 1, '坏掉的章')]),
    'encode failure aborts package',
    '坏掉的章',
  );

  // 同名标题：序号已保证不重名；安全化后序号仍唯一
  const b2 = fakeBuffer([new Float32Array(300)], 100);
  const pkg2 = buildChapterAudioPackage(b2, [
    mk('a', 0, 1, '同/名'),
    mk('b', 1, 2, '同?名'),
    mk('c', 2, 3, '同*名'),
  ]);
  eq(
    pkg2.segments.map((s) => s.filename),
    ['01-同_名.wav', '02-同_名.wav', '03-同_名.wav'],
    'index prefix keeps sanitized duplicates distinct',
  );
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
