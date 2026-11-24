/**
 * 纯 WAV(PCM16 / PCM24 / PCM32 / FLOAT32) 解码器，不依赖 DOM，便于在 Node 下验证。
 * 多声道会等比下混为单声道；返回的 samples 可直接用于 RMS / 峰值分析。
 */
export interface DecodedPcm {
  samples: Float32Array
  sampleRate: number
  duration: number
}

export function decodeWav(bytes: Uint8Array): DecodedPcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const readAscii = (offset: number, length: number) => {
    let text = ''
    for (let index = 0; index < length; index++) text += String.fromCharCode(view.getUint8(offset + index))
    return text
  }
  if (bytes.byteLength < 44 || readAscii(0, 4) !== 'RIFF' || readAscii(8, 4) !== 'WAVE') {
    throw new Error('仅支持 RIFF/WAVE 格式的 wav 录音。')
  }
  let offset = 12
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let data: Uint8Array | null = null
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(offset, 4)
    const chunkSize = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (body + chunkSize > bytes.byteLength) throw new Error('wav 数据块不完整。')
    if (chunkId === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (chunkId === 'data') {
      data = bytes.subarray(body, body + chunkSize)
    }
    offset = body + chunkSize + (chunkSize % 2)
  }
  if (!data || !channels || !sampleRate) throw new Error('wav 缺少 fmt/data 块。')
  if (![1, 3].includes(format)) throw new Error('仅支持 PCM 与 IEEE float 格式的 wav。')
  if (![16, 24, 32].includes(bitsPerSample)) throw new Error('不支持的采样位深。')
  const frameCount = Math.floor(data.byteLength / channels / (bitsPerSample / 8))
  const samples = new Float32Array(frameCount)
  if (format === 3 && bitsPerSample === 32) {
    for (let frame = 0; frame < frameCount; frame++) {
      let sum = 0
      for (let channel = 0; channel < channels; channel++) {
        sum += view.getFloat32((frame * channels + channel) * 4 + data.byteOffset, true)
      }
      samples[frame] = sum / channels
    }
  } else {
    const bytesPerSample = bitsPerSample / 8
    const maxSigned = 2 ** (bitsPerSample - 1)
    for (let frame = 0; frame < frameCount; frame++) {
      let sum = 0
      for (let channel = 0; channel < channels; channel++) {
        const base = (frame * channels + channel) * bytesPerSample + data.byteOffset
        let value = 0
        if (bitsPerSample === 16) value = view.getInt16(base, true)
        else if (bitsPerSample === 32) value = view.getInt32(base, true)
        else {
          value = (view.getUint8(base) | view.getUint8(base + 1) << 8 | view.getUint8(base + 2) << 16)
          if (value >= maxSigned) value -= 2 ** 24
        }
        sum += value / maxSigned
      }
      samples[frame] = sum / channels
    }
  }
  return { samples, sampleRate, duration: frameCount / sampleRate }
}
