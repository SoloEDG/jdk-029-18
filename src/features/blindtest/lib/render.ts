import type { AnalysisResult, BlindChannel, GainPoint, ListenMode } from '../model/types.ts'
import { buildAutomation, gainAt } from './gain.ts'

export interface RenderedTake {
  channel: BlindChannel
  samples: Float32Array
  sampleRate: number
}

/**
 * 按增益自动化把一支录音离线渲染成实际听到的采样（与 Web Audio GainNode 同一语义：
 * 关键点之间线性插值）。raw 模式恒为 1，输出必须与原声逐采样相同。
 */
export function renderTake(analysis: AnalysisResult, channel: BlindChannel, mode: ListenMode): RenderedTake {
  const points = buildAutomation(analysis, mode)
  const output = new Float32Array(analysis.take.samples.length)
  for (let index = 0; index < output.length; index++) {
    const time = index / analysis.take.sampleRate
    output[index] = analysis.take.samples[index] * gainAt(points, time)
  }
  return { channel, samples: output, sampleRate: analysis.take.sampleRate }
}

/** 模拟一次「同一歌时 X→Y 快切」的混合输出，断言两路在切换点使用的增益与各自独立渲染一致。 */
export function renderSwitch(
  analyses: Record<BlindChannel, AnalysisResult>,
  order: BlindChannel[],
  switchAt: number,
  duration: number,
  sampleRate: number,
): Float32Array {
  const automations = new Map<BlindChannel, GainPoint[]>(
    order.map(channel => [channel, buildAutomation(analyses[channel], 'calibrated')]),
  )
  const total = Math.round(duration * sampleRate)
  const output = new Float32Array(total)
  const switchFrame = Math.round(switchAt * sampleRate)
  for (let index = 0; index < total; index++) {
    const time = index / sampleRate
    const active = index < switchFrame ? order[0] : order[1]
    const analysis = analyses[active]
    const gain = gainAt(automations.get(active)!, time)
    const sourceIndex = Math.min(index, analysis.take.samples.length - 1)
    output[index] = analysis.take.samples[sourceIndex] * gain
  }
  return output
}
