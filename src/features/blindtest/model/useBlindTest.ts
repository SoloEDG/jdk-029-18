import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import type { BlindChannel, BlindPlan, BlindTake, ListenMode } from '../model/types.ts'
import { analyze } from '../lib/analysis.ts'
import { BlindEngine, type AudioClock } from '../lib/engine.ts'
import { DEFAULT_GAIN_SETTINGS, buildAutomation as buildAutomationPoints, gainAt as gainAtPoints, planGains, type GainSettings } from '../lib/gain.ts'
import { buildPlan } from '../lib/matching.ts'
import { decodeWav } from '../lib/wav.ts'

export interface BlindSource {
  id: string
  label: string
  audio: Blob
}

async function toTake(source: BlindSource): Promise<BlindTake> {
  const bytes = new Uint8Array(await source.audio.arrayBuffer())
  const decoded = decodeWav(bytes)
  return { id: source.id, label: source.label, ...decoded }
}

export function useBlindTest(clockFactory: () => AudioClock = () => new AudioContext() as unknown as AudioClock) {
  const loading = ref(false)
  const issue = ref('')
  const plan = shallowRef<BlindPlan | null>(null)
  const channel = ref<BlindChannel>('X')
  const isPlaying = ref(false)
  const position = ref(0)
  const revealed = ref(false)
  const mode = ref<ListenMode>('calibrated')
  const settings = ref<GainSettings>({ ...DEFAULT_GAIN_SETTINGS })
  /** 盲随机映射：界面通道 X/Y 实际对应输入槽 a/b 的哪一边。 */
  const mapping = ref<{ X: 'a' | 'b'; Y: 'a' | 'b' }>({ X: 'a', Y: 'b' })

  let engine: BlindEngine | null = null
  let frame = 0

  const duration = computed(() => {
    const current = plan.value ? (mapping.value[channel.value] === 'a' ? plan.value.a : plan.value.b) : null
    return current?.take.duration ?? 0
  })

  function ensureEngine(): BlindEngine {
    if (engine) return engine
    engine = new BlindEngine({ clock: clockFactory(), onEnded: () => { isPlaying.value = false } })
    return engine
  }

  async function load(next: { X: BlindSource | null; Y: BlindSource | null }) {
    issue.value = ''
    if (!next.X || !next.Y) {
      issue.value = '请为 X、Y 各选一支录音。'
      return
    }
    loading.value = true
    engine?.pause()
    isPlaying.value = false
    try {
      const [takeX, takeY] = await Promise.all([toTake(next.X), toTake(next.Y)])
      const seed = crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0
      mapping.value = seed ? { X: 'a', Y: 'b' } : { X: 'b', Y: 'a' }
      const takeA = mapping.value.X === 'a' ? takeX : takeY
      const takeB = mapping.value.X === 'a' ? takeY : takeX
      const built = buildPlan(analyze(takeA), analyze(takeB))
      planGains(built, settings.value)
      plan.value = built
      revealed.value = false
      position.value = 0
      engine?.dispose()
      engine = null
    } catch (error) {
      issue.value = error instanceof Error ? error.message : '录音解析失败。'
    } finally {
      loading.value = false
    }
  }

  async function startEngine() {
    if (!plan.value) return
    const player = ensureEngine()
    if (!player.readyChannels.length) {
      const a = plan.value.a
      const b = plan.value.b
      player.load('X', mapping.value.X === 'a' ? a : b)
      player.load('Y', mapping.value.Y === 'a' ? a : b)
    }
    await player.clock.resume()
    player.play()
    isPlaying.value = player.isPlaying
    channel.value = player.channel
    tick()
  }

  function tick() {
    cancelAnimationFrame(frame)
    const render = () => {
      if (!engine) return
      position.value = engine.position()
      if (engine.isPlaying) frame = requestAnimationFrame(render)
      else isPlaying.value = false
    }
    frame = requestAnimationFrame(render)
  }

  function togglePlay() {
    if (!plan.value || loading.value) return
    if (engine?.isPlaying) { engine.pause(); isPlaying.value = false; cancelAnimationFrame(frame); return }
    void startEngine()
  }

  function selectChannel(next: BlindChannel) {
    channel.value = next
    engine?.switchTo(next)
    if (engine?.isPlaying) tick()
  }

  function seek(seconds: number) {
    engine?.seek(seconds)
    position.value = seconds
  }

  function restart() { engine?.restart(); position.value = 0 }

  function reveal() {
    revealed.value = true
  }

  function toggleMode() {
    const next: ListenMode = mode.value === 'calibrated' ? 'raw' : 'calibrated'
    mode.value = next
    engine?.setMode(next)
  }

  function updateSettings(next: GainSettings) {
    settings.value = next
    if (plan.value) {
      planGains(plan.value, next)
      const wasPlaying = engine?.isPlaying ?? false
      const at = position.value
      engine?.dispose()
      engine = null
      position.value = at
      if (wasPlaying) void startEngine()
    }
  }

  /** 界面证据条用：取指定通道在某歌时的实际增益（raw 模式恒为 1）。 */
  function engineGainAt(panelChannel: BlindChannel, time: number) {
    if (!plan.value) return 1
    const side = mapping.value[panelChannel]
    const analysis = side === 'a' ? plan.value.a : plan.value.b
    const points = buildAutomationPoints(analysis, mode.value)
    return gainAtPoints(points, time)
  }

  onBeforeUnmount(() => { cancelAnimationFrame(frame); engine?.dispose(); engine = null })

  return {
    loading, issue, plan, channel, isPlaying, position, duration, revealed, mode, settings, mapping,
    load, togglePlay, selectChannel, seek, restart, reveal, toggleMode, updateSettings, engineGainAt,
  }
}
