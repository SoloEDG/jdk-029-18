export type SegmentKind = 'soft' | 'plosive' | 'gap' | 'silence' | 'reliable'

/** 按帧切分后得到的可听度证据片段，时间均为相对整支录音的秒数。 */
export interface AudioSegment {
  id: number
  kind: SegmentKind
  start: number
  end: number
  rms: number
  peak: number
  /** 规划后该片段使用的线性增益（1 表示原声不动）。 */
  gain: number
  /** 未参与匹配 / 未做增益调整时给出的中文原因，空字符串表示证据充分。 */
  reason: string
}

export interface FrameStat {
  time: number
  rms: number
  peak: number
  plosive: boolean
  voiced: boolean
}

export interface BlindTake {
  id: string
  label: string
  samples: Float32Array
  sampleRate: number
  duration: number
}

export interface AnalysisResult {
  take: BlindTake
  frames: FrameStat[]
  segments: AudioSegment[]
  noiseFloor: number
}

export interface MatchedPair {
  aSegmentId: number
  bSegmentId: number
  /** 对齐到 A 时间轴后的 B 片段起点（秒）。 */
  offsetSeconds: number
  similarity: number
  sameKind: boolean
  note: string
}

export interface BlindPlan {
  a: AnalysisResult
  b: AnalysisResult
  pairs: MatchedPair[]
  matchedAIds: ReadonlySet<number>
  matchedBIds: ReadonlySet<number>
  warnings: string[]
}

export type BlindChannel = 'X' | 'Y'
export type ListenMode = 'calibrated' | 'raw'

export interface GainPoint {
  time: number
  gain: number
}
