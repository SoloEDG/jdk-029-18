import type { AnalysisResult, AudioSegment, BlindTake, FrameStat, SegmentKind } from '../model/types.ts'

const FRAME_MS = 25
const HOP_MS = 12.5
const PLOSIVE_PEAK = 0.4
const PLOSIVE_GAIN_OVER_NOISE = 20
const PLOSIVE_JUMP = 2.2
const VOICED_OVER_NOISE = 12
const SOFT_BELOW_RELIABLE_DB = 8
const MIN_SOFT_SECONDS = 0.6
const MIN_RELIABLE_SECONDS = 0.35
const GAP_SECONDS = 0.22

function rmsOf(samples: Float32Array, start: number, end: number) {
  let sum = 0
  let peak = 0
  for (let index = start; index < end; index++) {
    const value = samples[index]
    sum += value * value
    const absolute = Math.abs(value)
    if (absolute > peak) peak = absolute
  }
  return { rms: Math.sqrt(sum / Math.max(1, end - start)), peak }
}

/**
 * 本底锚点：取最低 3% 帧 RMS 的中位数。
 * 录音再长，真正接近本底的只有漏唱/首尾安静；3% 足够小，不会被轻唱段占据。
 */
function noiseFloorOf(frames: FrameStat[]) {
  const ordered = frames.map(frame => frame.rms).filter(value => value > 0).sort((a, b) => a - b)
  if (!ordered.length) return 1e-6
  const cutoff = Math.max(2, Math.ceil(ordered.length * 0.03))
  const lower = ordered.slice(0, cutoff)
  return Math.max(1e-7, lower[Math.floor((lower.length - 1) / 2)])
}

/**
 * 短爆破音（可嵌在演唱帧里）：峰值绝对门限 + 高于本底 20dB，
 * 且相对前后相邻帧峰值有 ≥2.2 倍瞬时跳跃——持续重唱不会产生这种局部突变。
 */
function markPlosives(frames: FrameStat[], noiseFloor: number) {
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]
    const neighbours = [frames[index - 2], frames[index - 1], frames[index + 1], frames[index + 2]]
      .filter((item): item is FrameStat => Boolean(item))
    const neighbourPeak = neighbours.reduce((sum, item) => sum + item.peak, 0) / Math.max(1, neighbours.length)
    frame.plosive = frame.peak >= PLOSIVE_PEAK
      && 20 * Math.log10(frame.peak / noiseFloor) >= PLOSIVE_GAIN_OVER_NOISE
      && frame.peak >= neighbourPeak * PLOSIVE_JUMP
  }
}

interface Run {
  kind: SegmentKind | 'voiced'
  startFrame: number
  endFrame: number
}

/** 漏唱 = 演唱区间内部的未发声段；录音首尾安静归为 silence。 */
function unvoicedRuns(frames: FrameStat[], voicedAt: (index: number) => boolean): Run[] {
  const runs: Run[] = []
  let index = 0
  while (index < frames.length) {
    if (voicedAt(index)) { index++; continue }
    const start = index
    while (index < frames.length && !voicedAt(index)) index++
    runs.push({ kind: start === 0 || index === frames.length ? 'silence' : 'gap', startFrame: start, endFrame: index })
  }
  return runs
}

function buildSegments(frames: FrameStat[], reliableThreshold: number): AudioSegment[] {
  const gaps = unvoicedRuns(frames, index => frames[index].voiced)
    .filter(run => run.kind === 'gap')
    .filter(run => (frames[run.endFrame]?.time ?? frames[run.startFrame].time + HOP_MS / 1000) - frames[run.startFrame].time >= GAP_SECONDS)
  const runs: Run[] = []
  let cursor = 0
  for (const gap of [...gaps].sort((a, b) => a.startFrame - b.startFrame)) {
    if (gap.startFrame > cursor) runs.push({ kind: 'voiced', startFrame: cursor, endFrame: gap.startFrame })
    runs.push(gap)
    cursor = gap.endFrame
  }
  if (cursor < frames.length) runs.push({ kind: 'voiced', startFrame: cursor, endFrame: frames.length })

  const segments: AudioSegment[] = []
  let segmentId = 0
  const push = (kind: SegmentKind, startFrame: number, endFrame: number, reason = '') => {
    const slice = frames.slice(startFrame, endFrame)
    const rms = Math.sqrt(slice.reduce((sum, frame) => sum + frame.rms ** 2, 0) / Math.max(1, slice.length))
    const peak = slice.reduce((max, frame) => Math.max(max, frame.peak), 0)
    segments.push({
      id: segmentId++, kind,
      start: frames[startFrame].time,
      end: (frames[endFrame - 1]?.time ?? frames[startFrame].time) + HOP_MS / 1000,
      rms, peak, gain: 1, reason,
    })
  }

  /**
   * 边界处 ≤3 帧的瞬时碎片（轻唱/可靠的过渡抖动）吸收进相邻发声段，
   * 不单独作为「证据不足」片段；爆破音本身就短，不参与吸收。
   */
  function mergeFragments(items: Array<{ kind: SegmentKind; startFrame: number; endFrame: number }>) {
    for (let index = 0; index < items.length; index++) {
      const current = items[index]
      if (current.kind === 'plosive') continue
      const length = frames[current.endFrame - 1].time - frames[current.startFrame].time
      if (length > 3 * HOP_MS / 1000) continue
      const previous = items[index - 1]
      const next = items[index + 1]
      const target = previous && previous.kind !== 'plosive' ? previous : next && next.kind !== 'plosive' ? next : null
      if (!target) continue
      target.startFrame = Math.min(target.startFrame, current.startFrame)
      target.endFrame = Math.max(target.endFrame, current.endFrame)
      items.splice(index, 1)
      index--
    }
    // 吸收后可能出现相邻同类段（如 reliable 碎片并入 soft 后两段 soft 相接），收尾合并。
    for (let index = 1; index < items.length; index++) {
      if (items[index].kind === items[index - 1].kind) {
        items[index - 1].endFrame = items[index].endFrame
        items.splice(index, 1)
        index--
      }
    }
    return items
  }

  for (const run of runs) {
    if (run.kind !== 'voiced') { push(run.kind, run.startFrame, run.endFrame); continue }
    const items: Array<{ kind: SegmentKind; startFrame: number; endFrame: number }> = []
    let block = run.startFrame
    while (block < run.endFrame) {
      const frame = frames[block]
      const kind: SegmentKind = frame.plosive ? 'plosive' : frame.rms < reliableThreshold ? 'soft' : 'reliable'
      let end = block + 1
      while (end < run.endFrame) {
        const candidate = frames[end]
        const candidateKind = candidate.plosive ? 'plosive' : candidate.rms < reliableThreshold ? 'soft' : 'reliable'
        if (candidateKind !== kind) break
        end++
      }
      items.push({ kind, startFrame: block, endFrame: end })
      block = end
    }
    for (const item of mergeFragments(items)) {
      const length = (frames[item.endFrame - 1]?.time ?? frames[item.startFrame].time) + HOP_MS / 1000 - frames[item.startFrame].time
      let reason = ''
      if (item.kind === 'soft' && length < MIN_SOFT_SECONDS) reason = '轻唱片段过短，证据不足，保留原声。'
      if (item.kind === 'reliable' && length < MIN_RELIABLE_SECONDS) reason = '可靠发声过短，证据不足，保留原声。'
      push(item.kind, item.startFrame, item.endFrame, reason)
    }
  }
  return segments.sort((a, b) => a.start - b.start).map((segment, index) => ({ ...segment, id: index }))
}

export function analyze(take: BlindTake): AnalysisResult {
  const frameSize = Math.round(take.sampleRate * FRAME_MS / 1000)
  const hop = Math.round(take.sampleRate * HOP_MS / 1000)
  const frames: FrameStat[] = []
  for (let start = 0; start + frameSize <= take.samples.length; start += hop) {
    const { rms, peak } = rmsOf(take.samples, start, start + frameSize)
    frames.push({ time: start / take.sampleRate, rms, peak, plosive: false, voiced: false })
  }
  const noiseFloor = noiseFloorOf(frames)
  const voicedThreshold = noiseFloor * 10 ** (VOICED_OVER_NOISE / 20)
  for (const frame of frames) frame.voiced = frame.rms >= voicedThreshold
  markPlosives(frames, noiseFloor)
  // 轻唱/可靠分界：发声帧 RMS 中位数下浮 8dB；低于该线的持续发声即轻唱。
  const voicedRms = frames.filter(frame => frame.voiced).map(frame => frame.rms).sort((a, b) => a - b)
  const voicedMedian = voicedRms[Math.floor(voicedRms.length / 2)] ?? noiseFloor * 10
  const reliableThreshold = Math.max(voicedThreshold, voicedMedian / 10 ** (SOFT_BELOW_RELIABLE_DB / 20))
  const segments = buildSegments(frames, reliableThreshold)
  return { take, frames, segments, noiseFloor }
}
