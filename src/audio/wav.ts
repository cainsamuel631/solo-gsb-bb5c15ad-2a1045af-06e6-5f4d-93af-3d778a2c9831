import type { AudioBufferLike } from '../types';

/**
 * 把时间（秒）钳制到音频范围内再转换为采样索引。
 *
 * 采样区间统一采用**左闭右开** `[startSample, endSample)`：相邻章节共用的
 * 边界经过 `Math.round` 得到同一个整数索引，前一章在该索引前一采样结束、
 * 后一章从该索引开始，既不重复也不漏采样。结果再做一次整数钳制，消除
 * 边界时间因浮点运算微微超出 [0, length] 的情况。
 */
export function timeToSample(time: number, sampleRate: number, totalSamples: number): number {
  const duration = totalSamples / sampleRate;
  const clamped = Math.min(Math.max(time, 0), duration);
  return Math.min(Math.max(Math.round(clamped * sampleRate), 0), totalSamples);
}

export interface SampleRange {
  /** 左闭右开：包含 startSample，不包含 endSample */
  startSample: number;
  endSample: number;
}

/**
 * 章节起止时间 → 左闭右开采样区间。时间先钳制到 [0, 音频时长]；
 * endSample <= startSample（零长度 / 越界裁剪后无剩余）时返回 null，
 * 调用方据此跳过该章节。
 */
export function chapterSampleRange(
  start: number,
  end: number,
  sampleRate: number,
  totalSamples: number,
): SampleRange | null {
  if (!(sampleRate > 0) || !(totalSamples > 0)) return null;
  const startSample = timeToSample(start, sampleRate, totalSamples);
  const endSample = timeToSample(end, sampleRate, totalSamples);
  if (endSample <= startSample) return null;
  return { startSample, endSample };
}

/** 16-bit PCM WAV 单文件允许的最大 PCM 数据长度（uint32 可表示范围）。 */
const MAX_PCM_DATA = 0xfffe0000;

/**
 * Float32 [-1, 1] → 线性 16-bit PCM（小端），保留原声道数与采样率。
 * 每声道截取后长度必须一致（同一采样区间）。超出 [-1, 1] 的样本钳制到
 * ±32767，不做削波之外的任何处理。
 */
export function encodePcm16Wav(sampleRate: number, channels: Float32Array[]): Uint8Array {
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    sampleRate > 0xffffffff ||
    Math.round(sampleRate) !== sampleRate
  ) {
    throw new Error('无效的采样率，无法编码 WAV。');
  }
  if (channels.length === 0) throw new Error('没有可编码的声道。');
  const frameCount = channels[0].length;
  if (frameCount === 0) throw new Error('片段长度为 0，无法编码 WAV。');
  if (channels.some((c) => c.length !== frameCount)) {
    throw new Error('各声道片段长度不一致，无法编码 WAV。');
  }
  const channelCount = channels.length;
  const dataSize = frameCount * channelCount * 2;
  if (dataSize > MAX_PCM_DATA) throw new Error('片段过大，超出 WAV 可表示范围。');
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  const u32 = (offset: number, v: number) => view.setUint32(offset, v, true);
  const u16 = (offset: number, v: number) => view.setUint16(offset, v, true);

  // RIFF / WAVE header（PCM, 16-bit, little-endian）
  writeStr(0, 'RIFF');
  u32(4, 36 + dataSize);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  u32(16, 16); // fmt chunk size
  u16(20, 1); // audio format = PCM
  u16(22, channelCount);
  u32(24, sampleRate);
  u32(28, sampleRate * channelCount * 2); // byte rate
  u16(32, channelCount * 2); // block align
  u16(34, 16); // bits per sample
  writeStr(36, 'data');
  u32(40, dataSize);

  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < channelCount; ch++) {
      let v = channels[ch][i];
      if (!(v > -1)) v = -1; // NaN / -Infinity 视为静音下限
      else if (v > 1) v = 1;
      else if (v < -1) v = -1;
      // 先四舍五入再取整，避免截断引入 ±1 量化偏差
      const int = Math.round(v * 32767);
      view.setInt16(offset, int, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/**
 * 从已解码 buffer 截取一个左闭右开采样区间并编码为 16-bit PCM WAV。
 * 直接按采样索引读取原声道 PCM（不经过 AudioBuffer.slice），保留原声道
 * 数与采样率；返回 null 表示区间无效（无任何采样）。
 */
export function encodeChapterWav(
  buffer: AudioBufferLike,
  range: SampleRange,
): Uint8Array | null {
  const { startSample, endSample } = range;
  if (endSample <= startSample) return null;
  if (
    startSample < 0 ||
    endSample > buffer.length ||
    startSample >= buffer.length
  ) {
    return null;
  }
  const frameCount = endSample - startSample;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const slice = new Float32Array(frameCount);
    slice.set(src.subarray(startSample, endSample));
    channels.push(slice);
  }
  return encodePcm16Wav(buffer.sampleRate, channels);
}
