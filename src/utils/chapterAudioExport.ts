import type { AudioBufferLike, Chapter } from '../types';
import { chapterSampleRange, encodeChapterWav } from '../audio/wav';
import { buildZip, type ZipEntry } from '../audio/zip';

/** 导出失败（无有效片段 / 编码出错）时抛出，消息可直接显示给用户。 */
export class ChapterAudioExportError extends Error {}

export interface ChapterAudioSegment {
  chapter: Chapter;
  filename: string;
  wav: Uint8Array;
  startSample: number;
  endSample: number;
}

export interface ChapterAudioPackage {
  zip: Uint8Array;
  /** 成功编码的片段（按开始时间排序） */
  segments: ChapterAudioSegment[];
  /** 因越界 / 零时长而被跳过的章节数 */
  skipped: number;
}

/**
 * 章节标题 → 跨平台安全文件名片段：
 * 替换 Windows 非法字符 `< > : " / \\ | ? *` 与控制字符、折叠空白、
 * 去除首尾空格与结尾点号；空标题回退 `chapter`；保留中文等 Unicode 字符
 * （ZIP 条目名按 UTF-8 写入）。命中 DOS 设备名时加下划线前缀。
 */
export function safeFileStem(title: string): string {
  let stem = title
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])($|\.)/i.test(stem)) {
    stem = `_${stem}`;
  }
  stem = stem.slice(0, 80).trim().replace(/[.\s]+$/g, '');
  return stem.length > 0 ? stem : 'chapter';
}

/**
 * 生成形如 `01-开场.wav` 的条目名：两位起步、随章节数自动补零的序号 +
 * 安全化标题。序号前缀保证排序与跨标题不重名；再做一次大小写不敏感的
 * 去重兜底（追加 -2 / -3 …）。
 */
export function buildEntryName(index: number, total: number, title: string): string {
  const width = Math.max(2, String(total).length);
  return `${String(index).padStart(width, '0')}-${safeFileStem(title)}.wav`;
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** ZIP 包文件名：`<音频主名>-chapters.zip`。 */
export function chapterPackageZipName(audioBaseName: string): string {
  return `${safeFileStem(audioBaseName)}-chapters.zip`;
}

/**
 * 按章节起止时间从**当前**已解码 AudioBuffer 截取音频并打成单个 ZIP。
 *
 * - 时间先钳制到 [0, 音频时长]，再换算为采样索引；片段为左闭右开区间
 *   `[startSample, endSample)`，相邻章节边界不重复、不漏采样；
 * - 保留原声道数与采样率，逐章编码 16-bit PCM WAV；
 * - 有效章节（裁剪后至少含 1 个采样）按开始时间排序，文件名含序号与
 *   安全化标题且互不重名；
 * - 没有任何可导出片段、或任一章节编码失败时抛出
 *   `ChapterAudioExportError`，调用方不得下载半成品。
 */
export function buildChapterAudioPackage(
  buffer: AudioBufferLike,
  chapters: Chapter[],
  now?: Date,
): ChapterAudioPackage {
  if (!buffer || buffer.length <= 0 || buffer.numberOfChannels <= 0) {
    throw new ChapterAudioExportError('当前没有可用的已解码音频，请重新导入后再导出。');
  }

  const sortedChapters = [...chapters].sort((a, b) => a.start - b.start || a.end - b.end);

  const resolved: { chapter: Chapter; startSample: number; endSample: number }[] = [];
  for (const chapter of sortedChapters) {
    const range = chapterSampleRange(
      chapter.start,
      chapter.end,
      buffer.sampleRate,
      buffer.length,
    );
    if (range) resolved.push({ chapter, ...range });
  }

  if (resolved.length === 0) {
    throw new ChapterAudioExportError(
      '没有可导出的章节片段：所有章节都在当前音频范围外或长度为 0。',
    );
  }

  const usedNames = new Set<string>();
  const entries: ZipEntry[] = [];
  const segments: ChapterAudioSegment[] = [];
  let encoded = 0;
  for (const item of resolved) {
    encoded += 1;
    let wav: Uint8Array | null = null;
    try {
      wav = encodeChapterWav(buffer, {
        startSample: item.startSample,
        endSample: item.endSample,
      });
      if (!wav) throw new Error('片段为空');
    } catch (err) {
      throw new ChapterAudioExportError(
        `章节「${item.chapter.title.trim() || `第 ${encoded} 章`}」音频编码失败` +
          `（${err instanceof Error ? err.message : '未知错误'}），已取消导出，未下载任何文件。`,
      );
    }
    const filename = uniqueName(
      buildEntryName(segments.length + 1, resolved.length, item.chapter.title),
      usedNames,
    );
    usedNames.add(filename.toLowerCase());
    entries.push({ filename, data: wav });
    segments.push({
      chapter: item.chapter,
      filename,
      wav,
      startSample: item.startSample,
      endSample: item.endSample,
    });
  }

  try {
    const zip = buildZip(entries, now);
    return { zip, segments, skipped: sortedChapters.length - resolved.length };
  } catch (err) {
    throw new ChapterAudioExportError(
      `ZIP 打包失败（${err instanceof Error ? err.message : '未知错误'}），已取消导出，未下载任何文件。`,
    );
  }
}
