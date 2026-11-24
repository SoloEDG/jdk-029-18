/** 确定性模拟 Web Audio：所有调度落到虚拟时钟，断言自动化与播放头完全可复现。 */
export interface ScheduledValue { time: number; value: number }

export class MockAudioParam {
  value: number
  readonly scheduled: ScheduledValue[] = []
  constructor(initial = 1) { this.value = initial }
  setValueAtTime(value: number, time: number) {
    this.value = value
    this.scheduled.push({ time, value })
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.value = value
    this.scheduled.push({ time, value })
  }
  cancelScheduledValues(time: number) {
    for (let index = this.scheduled.length - 1; index >= 0; index--) {
      if (this.scheduled[index].time >= time) this.scheduled.splice(index, 1)
    }
  }
  valueAt(time: number) {
    let current = this.scheduled[0]?.value ?? this.value
    for (let index = 1; index < this.scheduled.length; index++) {
      if (time < this.scheduled[index].time) {
        const previous = this.scheduled[index - 1]
        if (!previous) return current
        const span = this.scheduled[index].time - previous.time
        if (span <= 0) return this.scheduled[index].value
        return previous.value + (this.scheduled[index].value - previous.value) * ((time - previous.time) / span)
      }
      current = this.scheduled[index].value
    }
    return current
  }
}

export class MockBufferSource {
  buffer: { length: number; sampleRate: number } | null = null
  onended: (() => void) | null = null
  readonly started: Array<{ when: number; offset: number }> = []
  stopped = false
  private readonly destination: MockAudioNode
  constructor(destination: MockAudioNode) { this.destination = destination }
  connect(node: MockAudioNode) { return node }
  start(when: number, offset = 0) {
    this.started.push({ when, offset })
    this.destination.sources.push(this)
  }
  stop() { this.stopped = true }
  disconnect() {
    const index = this.destination.sources.indexOf(this)
    if (index >= 0) this.destination.sources.splice(index, 1)
  }
}

export class MockGainNode {
  readonly gain = new MockAudioParam(1)
  disconnected = false
  connect(node: MockAudioNode) { return node }
  disconnect() { this.disconnected = true }
}

export class MockAudioNode {
  readonly sources: MockBufferSource[] = []
}

export class MockClock {
  currentTime = 0
  readonly destination = new MockAudioNode()
  private readonly bufferCount = { created: 0 }
  async resume() { /* 立即就绪 */ }
  createBuffer(channels: number, length: number, sampleRate: number) {
    this.bufferCount.created++
    const data = Array.from({ length: channels }, () => new Float32Array(length))
    return {
      numberOfChannels: channels, length, sampleRate,
      copyToChannel(input: Float32Array, channel: number) { data[channel].set(input) },
      getChannelData(channel: number) { return data[channel] },
    }
  }
  createBufferSource() { return new MockBufferSource(this.destination) }
  createGain() { return new MockGainNode() }
  advance(seconds: number) { this.currentTime += seconds }
}
