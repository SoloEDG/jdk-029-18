import type { AnalysisResult, AudioSegment, BlindPlan, GainPoint, ListenMode } from '../model/types.ts'

const MAX_BOOST_DB = 12
const MAX_RELIABLE_MOVE_DB = 3
const RAMP_MS = 60

export const dbToGain = (db: number) => 10 ** (db / 20)
export const gainToDb = (gain: number) => 20 * Math.log10(Math.max(gain, 1e-6))
export const clampGain = (gain: number, minDb: number, maxDb: number) =>
  Math.min(dbToGain(maxDb), Math.max(dbToGain(minDb), gain))

export interface GainSettings {
  /** 用户校定的「轻唱可听清」目标电平（dBFS，片段 RMS 对齐到这里）。 */
  targetQuietDb: number
  /** 峰值上限（dBFS），超过则只压低不抬升，避免爆破音失真。 */
  ceilingDb: number
}

export const DEFAULT_GAIN_SETTINGS: GainSettings = { targetQuietDb: -30, ceilingDb: -1 }

function pairOf(plan: BlindPlan, side: 'a' | 'b', segmentId: number) {
  return plan.pairs.find(pair => side === 'a' ? pair.aSegmentId === segmentId : pair.bSegmentId === segmentId)
}

function applySegmentRule(segment: AudioSegment, settings: GainSettings, matched: boolean) {
  const ceiling = dbToGain(settings.ceilingDb)
  const peakCap = segment.peak > 1e-6 ? ceiling / segment.peak : dbToGain(MAX_BOOST_DB)
  if (segment.kind === 'gap' || segment.kind === 'silence') {
    segment.gain = 1
    if (!segment.reason) segment.reason = segment.kind === 'gap' ? '漏唱段保持原声，不补声。' : '首尾安静段保持原声。'
    return
  }
  if (segment.kind === 'plosive') {
    // 短爆破音只做防削顶压低，绝不向上抬。
    segment.gain = Math.min(1, peakCap)
    if (!segment.reason) segment.reason = '爆破音不抬升，仅在超峰值上限时压低，保留瞬态重音。'
    return
  }
  if (segment.reason) {
    // 证据不足的片段（过短 / 未匹配）保留原声。
    segment.gain = 1
    return
  }
  if (segment.kind === 'soft') {
    const target = dbToGain(settings.targetQuietDb)
    const desired = segment.rms > 1e-6 ? target / segment.rms : 1
    const capped = Math.min(desired, peakCap)
    segment.gain = clampGain(capped, 0, MAX_BOOST_DB)
    if (segment.gain < desired * 0.99) segment.reason = '轻声补到可听阈值会顶到峰值上限，已按上限钳制。'
    else if (!matched) segment.reason = '未找到匹配片段，按个人可听阈值单独补增益。'
    return
  }
  // reliable：未匹配就不动；匹配后的两两对齐在 alignPairs 中处理。
  segment.gain = 1
  if (!matched && !segment.reason) segment.reason = '可靠发声但无匹配对象，保持原声。'
}

/** 匹配上的可靠发声片段向双方 RMS 的几何中点对齐，限制 ±3dB，避免抹平原唱重音。 */
function alignPairs(plan: BlindPlan, settings: GainSettings) {
  const ceiling = dbToGain(settings.ceilingDb)
  for (const pair of plan.pairs) {
    const segmentA = plan.a.segments.find(segment => segment.id === pair.aSegmentId)!
    const segmentB = plan.b.segments.find(segment => segment.id === pair.bSegmentId)!
    if (segmentA.kind !== 'reliable' || segmentB.kind !== 'reliable') continue
    const common = Math.sqrt(segmentA.rms * segmentB.rms)
    const desiredA = common / Math.max(segmentA.rms, 1e-6)
    const desiredB = common / Math.max(segmentB.rms, 1e-6)
    segmentA.gain = clampGain(Math.min(desiredA, ceiling / Math.max(segmentA.peak, 1e-6)), -MAX_RELIABLE_MOVE_DB, MAX_RELIABLE_MOVE_DB)
    segmentB.gain = clampGain(Math.min(desiredB, ceiling / Math.max(segmentB.peak, 1e-6)), -MAX_RELIABLE_MOVE_DB, MAX_RELIABLE_MOVE_DB)
    segmentA.reason = pair.note || '匹配片段，双方电平向几何中点对齐（±3dB 内）。'
    segmentB.reason = pair.note || '匹配片段，双方电平向几何中点对齐（±3dB 内）。'
  }
}

/** 重音校验：相邻发声片段原本峰值更响的一侧，处理后仍须更响；被违反则回退该片段增益。 */
export function preserveAccents(analysis: AnalysisResult) {
  const voiced = analysis.segments.filter(segment => segment.kind === 'soft' || segment.kind === 'reliable' || segment.kind === 'plosive')
  for (let index = 1; index < voiced.length; index++) {
    const previous = voiced[index - 1]
    const current = voiced[index]
    if (previous.peak === current.peak) continue
    const louderWasPrevious = previous.peak > current.peak
    const nowPrevious = previous.peak * previous.gain
    const nowCurrent = current.peak * current.gain
    if ((louderWasPrevious && nowPrevious < nowCurrent) || (!louderWasPrevious && nowCurrent < nowPrevious)) {
      const offender = louderWasPrevious ? current : previous
      const reference = louderWasPrevious ? previous : current
      offender.gain = Math.min(offender.gain, reference.gain * (reference.peak / Math.max(offender.peak, 1e-6)) * 0.98)
      offender.reason = `${offender.reason ? `${offender.reason} ` : ''}为保留原有重音次序，已限制该片段增益。`
    }
  }
}

export function planGains(plan: BlindPlan, settings: GainSettings = DEFAULT_GAIN_SETTINGS) {
  for (const segment of plan.a.segments) applySegmentRule(segment, settings, plan.matchedAIds.has(segment.id))
  for (const segment of plan.b.segments) applySegmentRule(segment, settings, plan.matchedBIds.has(segment.id))
  alignPairs(plan, settings)
  preserveAccents(plan.a)
  preserveAccents(plan.b)
  return plan
}

/** 生成增益自动化节点：片段内恒定，边界处 60ms 线性过渡，保证快切时同一歌时可复现。 */
export function buildAutomation(analysis: AnalysisResult, mode: ListenMode): GainPoint[] {
  if (mode === 'raw') return [{ time: 0, gain: 1 }]
  const points: GainPoint[] = [{ time: 0, gain: analysis.segments[0]?.gain ?? 1 }]
  const ramp = RAMP_MS / 1000
  for (let index = 1; index < analysis.segments.length; index++) {
    const boundary = analysis.segments[index].start
    const before = analysis.segments[index - 1].gain
    const after = analysis.segments[index].gain
    if (before === after) continue
    points.push({ time: Math.max(0, boundary - ramp / 2), gain: before })
    points.push({ time: Math.min(analysis.take.duration, boundary + ramp / 2), gain: after })
  }
  const last = analysis.segments.at(-1)
  if (last) points.push({ time: analysis.take.duration, gain: last.gain })
  return points
}

export function gainAt(points: readonly GainPoint[], time: number) {
  if (time <= points[0].time) return points[0].gain
  for (let index = 1; index < points.length; index++) {
    if (time <= points[index].time) {
      const previous = points[index - 1]
      const span = points[index].time - previous.time
      if (span <= 0) return points[index].gain
      const ratio = (time - previous.time) / span
      return previous.gain + (points[index].gain - previous.gain) * ratio
    }
  }
  return points.at(-1)!.gain
}
