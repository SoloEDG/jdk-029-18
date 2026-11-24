/**
 * 合成两支「轻唱」对照录音（确定性、无外部依赖）：
 *  - 两段较长的轻唱（≈2.2s / ≈2.4s）+ 可靠发声校对段；
 *  - 各有一个错位爆破音（相距 >120ms，匹配应失败并保留原声）；
 *  - 各有一段漏唱（位置不同）；
 *  - B 整体比 A 低 6dB，用于验证轻声补增益与可靠段 ±3dB 对齐。
 */
export interface SyntheticTake {
  name: string
  samples: Float32Array
  sampleRate: number
  duration: number
  softWindows: Array<[number, number]>
  plosiveAt: number
  gapWindow: [number, number]
}

const RATE = 22050
const DURATION = 10

function f0At(time: number) {
  return 196 + 18 * Math.sin(2 * Math.PI * time / 3.4)
}

function voiceSample(time: number, level: number) {
  const fundamental = f0At(time)
  const vibrato = 1 + 0.03 * Math.sin(2 * Math.PI * 5.5 * time)
  const value = Math.sin(2 * Math.PI * fundamental * vibrato * time)
    + 0.45 * Math.sin(2 * Math.PI * fundamental * 2 * vibrato * time)
    + 0.22 * Math.sin(2 * Math.PI * fundamental * 3 * vibrato * time)
  const swell = 0.72 + 0.28 * Math.sin(Math.PI * ((time * 0.9) % 1))
  return level * swell * value / 1.67
}

function addPlosive(samples: Float32Array, at: number, peak: number) {
  const center = Math.round(at * RATE)
  const length = Math.round(0.006 * RATE)
  for (let index = -length; index <= length; index++) {
    const ratio = index / length
    const envelope = Math.exp(-ratio * ratio * 14)
    const noise = (Math.sin(index * 12.9898) * 43758.5453) % 1
    samples[center + index] += peak * envelope * noise
  }
}

function buildTake(options: {
  name: string
  level: number
  plosiveAt: number
  gapWindow: [number, number]
  softWindows: Array<[number, number]>
}): SyntheticTake {
  const total = DURATION * RATE
  const samples = new Float32Array(total)
  const inWindow = (time: number, windows: Array<[number, number]>) =>
    windows.some(([from, to]) => time >= from && time < to)
  for (let index = 0; index < total; index++) {
    const time = index / RATE
    if (inWindow(time, [options.gapWindow])) {
      // 漏唱：不写入演唱声，只保留本底噪声。
      continue
    }
    const soft = inWindow(time, options.softWindows)
    const level = soft ? options.level * 0.28 : options.level
    samples[index] = voiceSample(time, level)
  }
  // 低幅恒定噪声底，模拟设备本底噪声（约 -60dBFS）。
  for (let index = 0; index < total; index++) {
    const noise = (Math.sin(index * 78.233) * 12543.639) % 1
    samples[index] += 0.00085 * noise
  }
  addPlosive(samples, options.plosiveAt, 0.72)
  return {
    name: options.name, samples, sampleRate: RATE, duration: DURATION,
    softWindows: options.softWindows, plosiveAt: options.plosiveAt, gapWindow: options.gapWindow,
  }
}

export function buildFixturePair() {
  const softA: Array<[number, number]> = [[1.4, 3.2], [6.0, 8.2]]
  const softB: Array<[number, number]> = [[1.4, 3.2], [6.0, 8.2]]
  const takeA = buildTake({
    name: 'take-a-soft', level: 0.22, plosiveAt: 4.1, gapWindow: [4.7, 5.1], softWindows: softA,
  })
  const takeB = buildTake({
    name: 'take-b-soft', level: 0.11, plosiveAt: 4.35, gapWindow: [8.4, 8.8], softWindows: softB,
  })
  return { takeA, takeB }
}

/** 16-bit 单声道 WAV 编码（Node 与浏览器均可调用）。 */
export function encodeWav(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, tag: string) => {
    for (const [index, char] of Array.from(tag).entries()) view.setUint8(offset + index, char.charCodeAt(0))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)
  ascii(8, 'WAVE'); ascii(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767), true)
  }
  return new Uint8Array(buffer)
}
