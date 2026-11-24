import type { AnalysisResult, AudioSegment, BlindPlan, FrameStat, MatchedPair } from '../model/types.ts'

const MAX_OFFSET_MS = 120
const MIN_SIMILARITY = 0.45
const MIN_SOFT_MATCH_SECONDS = 0.6

function envelope(frames: FrameStat[], from: number, to: number, sampleRate: number, hopSeconds: number) {
  const startFrame = Math.max(0, Math.round(from / hopSeconds))
  const endFrame = Math.min(frames.length, Math.round(to / hopSeconds))
  const points: number[] = []
  for (let index = startFrame; index < endFrame; index++) {
    points.push(frames[index].rms)
  }
  if (!points.length) return { points, hopSeconds, sampleRate }
  const max = Math.max(...points, 1e-6)
  return { points: points.map(value => value / max), hopSeconds, sampleRate }
}

function correlation(a: readonly number[], b: readonly number[]) {
  const length = Math.min(a.length, b.length)
  if (length < 3) return 0
  const sliceA = a.slice(0, length)
  const sliceB = b.slice(0, length)
  const meanA = sliceA.reduce((sum, value) => sum + value, 0) / length
  const meanB = sliceB.reduce((sum, value) => sum + value, 0) / length
  let numerator = 0
  let denomA = 0
  let denomB = 0
  for (let index = 0; index < length; index++) {
    const da = sliceA[index] - meanA
    const db = sliceB[index] - meanB
    numerator += da * db
    denomA += da * da
    denomB += db * db
  }
  const denominator = Math.sqrt(denomA * denomB)
  return denominator > 1e-12 ? numerator / denominator : 0
}

/** 在 ±120ms 内滑动 B 的包络，取最高相关；返回相对 A 的偏移秒数（正值=B 更晚）。 */
function bestOffset(a: AnalysisResult, b: AnalysisResult, segment: AudioSegment) {
  const hopSeconds = a.frames[1]?.time - a.frames[0]?.time || 0.0125
  const target = envelope(a.frames, segment.start, segment.end, a.take.sampleRate, hopSeconds)
  const maxShift = Math.round(MAX_OFFSET_MS / 1000 / hopSeconds)
  let best = { offset: 0, score: -1 }
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    const shiftedFrom = segment.start + shift * hopSeconds
    const shiftedTo = segment.end + shift * hopSeconds
    if (shiftedFrom < 0 || shiftedTo > b.take.duration) continue
    const candidate = envelope(b.frames, shiftedFrom, shiftedTo, b.take.sampleRate, hopSeconds)
    const score = correlation(target.points, candidate.points)
    if (score > best.score) best = { offset: shift * hopSeconds, score }
  }
  return best
}

function isComparable(segment: AudioSegment) {
  if (segment.kind === 'silence' || segment.kind === 'gap') return false
  if (segment.kind === 'plosive') return true
  return segment.end - segment.start >= MIN_SOFT_MATCH_SECONDS
}

export function buildPlan(a: AnalysisResult, b: AnalysisResult): BlindPlan {
  const pairs: MatchedPair[] = []
  const matchedA = new Set<number>()
  const matchedB = new Set<number>()
  const candidates = a.segments.filter(isComparable).map(segment => {
    const { offset, score } = bestOffset(a, b, segment)
    const bStart = segment.start + offset
    const overlap = b.segments
      .filter(other => isComparable(other) && !matchedB.has(other.id))
      .map(other => ({ other, overlap: Math.min(segment.end + offset, other.end) - Math.max(bStart, other.start) }))
      .filter(item => item.overlap > 0)
      .sort((left, right) => right.overlap - left.overlap)[0]
    return { segment, offset, score, peer: overlap?.other }
  }).sort((left, right) => right.score - left.score)

  for (const candidate of candidates) {
    const peer = candidate.peer
    if (!peer || candidate.score < MIN_SIMILARITY || matchedA.has(candidate.segment.id) || matchedB.has(peer.id)) continue
    matchedA.add(candidate.segment.id)
    matchedB.add(peer.id)
    const sameKind = peer.kind === candidate.segment.kind
    pairs.push({
      aSegmentId: candidate.segment.id,
      bSegmentId: peer.id,
      offsetSeconds: candidate.offset,
      similarity: candidate.score,
      sameKind,
      note: sameKind ? '' : `片段类型不同（A：${candidate.segment.kind} / B：${peer.kind}），只做电平对齐，不抹平重音。`,
    })
  }

  const warnings: string[] = []
  for (const segment of a.segments) {
    if (isComparable(segment) && !matchedA.has(segment.id)) {
      const reason = segment.kind === 'plosive'
        ? 'A 的爆破音在 B 的 ±120ms 内找不到对应瞬态，保留原声。'
        : segment.kind === 'gap'
          ? 'A 的漏唱段在 B 中无对应位置，保留原声。'
          : '包络相似度不足，证据太少，保留原声。'
      segment.reason = reason
      warnings.push(`A ${segment.kind} ${segment.start.toFixed(2)}s–${segment.end.toFixed(2)}s：${reason}`)
    }
  }
  for (const segment of b.segments) {
    if (isComparable(segment) && !matchedB.has(segment.id)) {
      const reason = segment.kind === 'plosive'
        ? 'B 的爆破音在 A 的 ±120ms 内找不到对应瞬态，保留原声。'
        : '包络相似度不足，证据太少，保留原声。'
      segment.reason = reason
      warnings.push(`B ${segment.kind} ${segment.start.toFixed(2)}s–${segment.end.toFixed(2)}s：${reason}`)
    }
  }
  return { a, b, pairs, matchedAIds: matchedA, matchedBIds: matchedB, warnings }
}
