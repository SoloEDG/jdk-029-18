import type { AnalysisResult, BlindChannel, GainPoint, ListenMode } from '../model/types.ts'
import { buildAutomation, gainAt } from './gain.ts'

/** Web Audio 的窄抽象，测试时用确定性的模拟时钟替换。 */
export interface AudioClock {
  readonly currentTime: number
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer
  createBufferSource(): AudioBufferSourceNode
  createGain(): GainNode
  readonly destination: AudioNode
  resume(): Promise<void>
}

export interface SlotEngine {
  source: AudioBufferSourceNode
  gain: GainNode
}

export interface EngineOptions {
  clock: AudioClock
  onEnded?: () => void
  /** 起播提前量（秒）；生产环境用 0.08 保证调度稳定，测试可传 0 做确定性断言。 */
  startDelay?: number
}

const DEFAULT_START_DELAY = 0.08
const SWITCH_FADE = 0.02
const CHANNELS: readonly BlindChannel[] = ['X', 'Y']

export class BlindEngine {
  readonly clock: AudioClock
  private readonly onEnded?: () => void
  private readonly startDelay: number
  private readonly plans = new Map<BlindChannel, AnalysisResult>()
  private readonly slots = new Map<BlindChannel, SlotEngine>()
  private readonly automation = new Map<BlindChannel, GainPoint[]>()
  private mode: ListenMode = 'calibrated'
  private active: BlindChannel = 'X'
  private offset = 0
  private playStartedAt = 0
  private playing = false

  constructor(options: EngineOptions) {
    this.clock = options.clock
    this.onEnded = options.onEnded
    this.startDelay = options.startDelay ?? DEFAULT_START_DELAY
  }

  load(channel: BlindChannel, analysis: AnalysisResult) {
    const wasPlaying = this.playing
    this.stopNodes()
    this.plans.set(channel, analysis)
    this.automation.set(channel, buildAutomation(analysis, this.mode))
    if (wasPlaying && this.plans.has(this.active)) this.startNodes(this.offset)
  }

  /** 揭晓前后切换「校准 / 原声」：在同一时间轴重建节点，原声（gain=1）随时可复听。 */
  setMode(mode: ListenMode) {
    if (mode === this.mode) return
    this.mode = mode
    for (const [channel, analysis] of this.plans) this.automation.set(channel, buildAutomation(analysis, mode))
    if (this.playing) {
      const position = this.position()
      this.stopNodes()
      this.startNodes(position)
    }
  }

  get isPlaying() { return this.playing }
  get channel() { return this.active }
  get listenMode() { return this.mode }
  get readyChannels() { return CHANNELS.filter(channel => this.plans.has(channel)) }

  private createSlot(channel: BlindChannel, atOffset: number, beginAt: number): SlotEngine {
    const analysis = this.plans.get(channel)!
    const buffer = this.clock.createBuffer(1, analysis.take.samples.length, analysis.take.sampleRate)
    buffer.copyToChannel(analysis.take.samples, 0)
    const source = this.clock.createBufferSource()
    source.buffer = buffer
    const gain = this.clock.createGain()
    const points = this.automation.get(channel)!
    gain.gain.setValueAtTime(channel === this.active ? gainAt(points, atOffset) : 0, beginAt)
    if (channel === this.active) {
      for (const point of points) {
        if (point.time <= atOffset) continue
        gain.gain.linearRampToValueAtTime(point.gain, beginAt + (point.time - atOffset))
      }
    }
    source.connect(gain).connect(this.clock.destination)
    source.onended = () => {
      if (this.active !== channel || !this.playing) return
      this.playing = false
      this.onEnded?.()
    }
    return { source, gain }
  }

  private startNodes(atOffset: number) {
    const beginAt = this.clock.currentTime + this.startDelay
    for (const channel of CHANNELS) {
      if (!this.plans.has(channel)) continue
      const slot = this.createSlot(channel, atOffset, beginAt)
      slot.source.start(beginAt, atOffset)
      this.slots.set(channel, slot)
    }
    this.offset = atOffset
    this.playStartedAt = beginAt
    this.playing = true
  }

  private stopNodes() {
    for (const slot of this.slots.values()) {
      try { slot.source.onended = null; slot.source.stop() } catch { /* 已停止 */ }
      try { slot.source.disconnect(); slot.gain.disconnect() } catch { /* 已断开 */ }
    }
    this.slots.clear()
    this.playing = false
  }

  play() {
    if (this.playing || !this.plans.has(this.active)) return
    this.startNodes(this.offset)
  }

  pause() {
    if (!this.playing) return
    this.offset = this.position()
    this.stopNodes()
  }

  seek(seconds: number) {
    const analysis = this.plans.get(this.active)
    if (!analysis) return
    const next = Math.max(0, Math.min(seconds, analysis.take.duration))
    const wasPlaying = this.playing
    this.stopNodes()
    this.offset = next
    if (wasPlaying) this.startNodes(next)
  }

  restart() { this.seek(0) }

  /** 同一歌时（保持播放头）快速切换 X/Y：仅做 20ms 交叉淡变，不重启 source、不移动播放头。 */
  switchTo(channel: BlindChannel) {
    if (channel === this.active) return
    if (!this.playing || !this.slots.size) { this.active = channel; return }
    const now = Math.max(this.clock.currentTime, this.playStartedAt)
    const atOffset = this.offset + (now - this.playStartedAt)
    const outgoing = this.slots.get(this.active)
    const incoming = this.slots.get(channel)
    if (outgoing) {
      outgoing.gain.gain.cancelScheduledValues(now)
      outgoing.gain.gain.setValueAtTime(outgoing.gain.gain.value, now)
      outgoing.gain.gain.linearRampToValueAtTime(0, now + SWITCH_FADE)
    }
    if (incoming) {
      const points = this.automation.get(channel)!
      incoming.gain.gain.cancelScheduledValues(now)
      incoming.gain.gain.setValueAtTime(0, now)
      incoming.gain.gain.linearRampToValueAtTime(gainAt(points, atOffset), now + SWITCH_FADE)
      for (const point of points) {
        if (point.time <= atOffset + SWITCH_FADE) continue
        incoming.gain.gain.linearRampToValueAtTime(point.gain, now + (point.time - atOffset))
      }
    }
    this.active = channel
  }

  position() {
    if (!this.playing) return this.offset
    return Math.min(
      this.plans.get(this.active)?.take.duration ?? this.offset,
      this.offset + Math.max(0, this.clock.currentTime - this.playStartedAt),
    )
  }

  /** 供 rAF 轮询当前实际增益（界面证据条），切换/暂停后仍按同一时间轴取值。 */
  activeGainAt(time: number) {
    const points = this.automation.get(this.active)
    return points ? gainAt(points, time) : 1
  }

  dispose() {
    this.stopNodes()
    this.plans.clear()
    this.automation.clear()
  }
}
