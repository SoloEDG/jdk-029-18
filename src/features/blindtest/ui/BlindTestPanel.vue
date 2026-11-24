<script setup lang="ts">
import { computed, ref } from 'vue'
import { Ear, Eye, EyeClosed, FileAudio, Pause, Play, RotateCcw, Shuffle, Sparkles } from '@lucide/vue'
import type { BlindChannel } from '../model/types'
import { useBlindTest, type BlindSource } from '../model/useBlindTest'
import EvidenceTrack from './EvidenceTrack.vue'
import { gainAt } from '../lib/gain'

const props = defineProps<{ takeOptions: Array<{ id: string; label: string; audio: Blob }> }>()
const emit = defineEmits<{ issue: [string] }>()

const blind = useBlindTest()
const picked = ref<{ X: BlindSource | null; Y: BlindSource | null }>({ X: null, Y: null })
const fileInputs = ref<Record<BlindChannel, HTMLInputElement | null>>({ X: null, Y: null })
const loadingDemo = ref(false)

const hasPair = computed(() => Boolean(picked.value.X && picked.value.Y))
const activeSide = computed(() => blind.plan.value ? blind.mapping.value[blind.channel.value] : null)

function chooseFile(channel: BlindChannel, event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (!file.type.includes('wav') && !file.name.toLowerCase().endsWith('.wav')) {
    emit('issue', '盲听对照仅支持 wav 录音。')
    return
  }
  picked.value = { ...picked.value, [channel]: { id: `${channel}-${file.name}-${file.size}`, label: file.name, audio: file } }
}

function chooseTake(channel: BlindChannel, event: Event) {
  const id = (event.target as HTMLSelectElement).value
  const take = props.takeOptions.find(item => item.id === id)
  if (!take) return
  picked.value = { ...picked.value, [channel]: { id: take.id, label: take.label, audio: take.audio } }
}

async function analyzePair() {
  if (!hasPair.value) return
  await blind.load(picked.value)
  if (blind.issue.value) emit('issue', blind.issue.value)
}

async function loadDemo() {
  loadingDemo.value = true
  try {
    const [aFile, bFile] = await Promise.all([
      fetch('/media/blind-demo/take-a-soft.wav').then(response => response.blob()),
      fetch('/media/blind-demo/take-b-soft.wav').then(response => response.blob()),
    ])
    picked.value = {
      X: { id: 'demo-a', label: '示例轻唱 A', audio: aFile },
      Y: { id: 'demo-b', label: '示例轻唱 B', audio: bFile },
    }
    await analyzePair()
  } catch {
    emit('issue', '示例录音载入失败。')
  } finally {
    loadingDemo.value = false
  }
}

function updateTarget(event: Event) {
  blind.updateSettings({ ...blind.settings.value, targetQuietDb: Number((event.target as HTMLInputElement).value) })
}
function updateCeiling(event: Event) {
  blind.updateSettings({ ...blind.settings.value, ceilingDb: Number((event.target as HTMLInputElement).value) })
}

const fillStyle = (value: number, min: number, max: number) => ({
  '--fill': `${(value - min) / (max - min) * 100}%`,
}) as Record<string, string>
</script>

<template>
  <section class="blind-panel" aria-labelledby="blind-title">
    <h2 class="rail-title" id="blind-title"><Ear :size="17" /> 匿名 A/B 对照 <Shuffle v-if="blind.plan.value" :size="13" class="shuffle-icon" /></h2>

    <div v-if="!blind.plan.value" class="blind-setup">
      <button class="demo-button" type="button" :disabled="loadingDemo" @click="loadDemo">
        <Sparkles :size="14" /> {{ loadingDemo ? '载入中…' : '载入示例对照（两支长轻唱）' }}
      </button>
      <div v-for="channel in (['X', 'Y'] as const)" :key="channel" class="slot-picker">
        <span class="slot-badge" :class="channel === 'X' ? 'slot-a' : 'slot-b'">{{ channel }}</span>
        <label class="file-picker">
          <FileAudio :size="14" />
          <input :ref="(element): void => { if (element) fileInputs[channel] = element as HTMLInputElement }" type="file"
            accept=".wav,audio/wav" @change="event => chooseFile(channel, event)" hidden />
          <button type="button" class="pick-button" @click="fileInputs[channel]?.click()">
            {{ picked[channel]?.label ?? '选择 wav 录音' }}
          </button>
        </label>
        <select v-if="takeOptions.length" :aria-label="`从本句录音选择 ${channel}`" @change="event => chooseTake(channel, event)">
          <option value="">用本句录音…</option>
          <option v-for="take in takeOptions" :key="take.id" :value="take.id">{{ take.label }}</option>
        </select>
      </div>
      <button class="analyze-button" type="button" :disabled="!hasPair || blind.loading.value" @click="analyzePair">
        {{ blind.loading.value ? '解析中…' : '开始匿名对照' }}
      </button>
      <p v-if="blind.issue.value" class="inline-error" role="alert">{{ blind.issue.value }}</p>
      <p class="blind-hint">X/Y 身份随机分配，揭晓前不显示来源；只做分段恒定增益与线性过渡，不压缩、不抹重音。</p>
    </div>

    <div v-else class="blind-player">
      <div class="channel-switch" role="group" aria-label="盲听通道快切">
        <button v-for="channel in (['X', 'Y'] as const)" :key="channel" type="button" class="channel-button"
          :class="{ active: blind.channel.value === channel, [channel === 'X' ? 'tone-a' : 'tone-b']: true }"
          @click="blind.selectChannel(channel)">
          <span class="channel-letter">{{ channel }}</span>
          <small>{{ blind.channel.value === channel ? '正在听' : '点击快切' }}</small>
        </button>
      </div>

      <div class="blind-controls">
        <button type="button" class="play-button-sm" :aria-label="blind.isPlaying.value ? '暂停' : '播放'" @click="blind.togglePlay()">
          <Pause v-if="blind.isPlaying.value" :size="15" fill="currentColor" />
          <Play v-else :size="15" fill="currentColor" />
        </button>
        <button type="button" class="icon-button-sm" aria-label="从头重播" @click="blind.restart"><RotateCcw :size="15" /></button>
        <input class="blind-scrub" type="range" min="0" :max="blind.duration.value" step="0.01"
          :value="blind.position.value" :style="fillStyle(blind.position.value, 0, blind.duration.value)"
          @input="event => blind.seek(Number((event.target as HTMLInputElement).value))" />
      </div>

      <EvidenceTrack v-for="channel in (['X', 'Y'] as const)" :key="channel" :channel="channel"
        :segments="(blind.mapping.value[channel] === 'a' ? blind.plan.value.a : blind.plan.value.b).segments"
        :duration="blind.duration.value" :position="blind.position.value" :active="blind.channel.value === channel"
        :revealed="blind.revealed.value" />

      <div class="mode-row">
        <button type="button" class="mode-button" :class="{ enabled: blind.mode.value === 'calibrated' }" @click="blind.mode.value !== 'calibrated' && blind.toggleMode()">
          <Ear :size="14" /> 校准响度
        </button>
        <button type="button" class="mode-button" :class="{ enabled: blind.mode.value === 'raw' }" @click="blind.mode.value !== 'raw' && blind.toggleMode()">
          <FileAudio :size="14" /> 原声复听
        </button>
      </div>

      <details class="calibration">
        <summary>试听响度校定</summary>
        <label>轻唱可听阈值 <strong class="mono">{{ blind.settings.value.targetQuietDb }} dBFS</strong>
          <input type="range" min="-42" max="-18" step="1" :value="blind.settings.value.targetQuietDb"
            :style="fillStyle(blind.settings.value.targetQuietDb, -42, -18)" @input="updateTarget" />
        </label>
        <label>峰值上限 <strong class="mono">{{ blind.settings.value.ceilingDb }} dBFS</strong>
          <input type="range" min="-6" max="0" step="0.5" :value="blind.settings.value.ceilingDb"
            :style="fillStyle(blind.settings.value.ceilingDb, -6, 0)" @input="updateCeiling" />
        </label>
        <p class="blind-hint">整体调低会让轻声低于可听范围，整体调高会让爆破音失真；因此只对匹配片段做有限对齐，轻声按阈值补、爆破音只压不抬。</p>
      </details>

      <ul v-if="blind.plan.value.warnings.length" class="warning-list">
        <li v-for="(warning, index) in blind.plan.value.warnings.slice(0, 4)" :key="index">{{ warning }}</li>
      </ul>

      <button type="button" class="reveal-button" @click="blind.reveal()">
        <Eye v-if="blind.revealed.value" :size="15" /><EyeClosed v-else :size="15" />
        {{ blind.revealed.value ? '已揭晓' : '揭晓 X / Y 身份' }}
      </button>
      <transition name="reveal">
        <div v-if="blind.revealed.value" class="reveal-map">
          <p><span class="slot-badge slot-a">X</span> = {{ blind.mapping.value.X === 'a' ? picked.X?.label : picked.Y?.label }}</p>
          <p><span class="slot-badge slot-b">Y</span> = {{ blind.mapping.value.Y === 'a' ? picked.X?.label : picked.Y?.label }}</p>
          <p class="blind-hint">当前听到的是 <strong>{{ activeSide === 'a' ? picked.X?.label : picked.Y?.label }}</strong>；切到「原声复听」可随时核对未处理录音。</p>
        </div>
      </transition>
    </div>
  </section>
</template>

<style scoped>
.blind-panel { display: grid; gap: 10px; }
.shuffle-icon { color: var(--gold); }
.blind-setup { display: grid; gap: 10px; }
.demo-button, .analyze-button, .reveal-button, .mode-button {
  min-height: 40px; border-radius: 5px; border: 1px solid #575648; background: #272b22;
  display: inline-flex; align-items: center; justify-content: center; gap: 7px; font-size: 12px;
}
.demo-button { background: #302c21; border-color: #8b7041; color: var(--gold); }
.demo-button:hover, .analyze-button:hover { background: #3a3d30; }
.analyze-button:disabled { opacity: .5; cursor: wait; }
.slot-picker { display: grid; gap: 6px; }
.slot-badge {
  width: 22px; height: 22px; border-radius: 4px; display: inline-grid; place-items: center;
  font: 700 12px var(--mono); background: #2c3335;
}
.slot-badge.slot-b { background: #382a2d; }
.file-picker { display: flex; align-items: center; gap: 7px; color: var(--muted); }
.pick-button {
  flex: 1; min-height: 38px; padding: 0 8px; text-align: left; border: 1px solid var(--rule);
  border-radius: 4px; background: var(--inset); color: var(--paper); font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.slot-picker select {
  min-height: 36px; padding: 0 5px; border: 1px solid var(--rule); border-radius: 4px;
  background: var(--inset); color: var(--paper); font-size: 11px;
}
.blind-hint { color: var(--soft); font-size: 10.5px; line-height: 1.6; }
.inline-error { color: #ffac98; font-size: 12px; }

.blind-player { display: grid; gap: 11px; }
.channel-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.channel-button {
  min-height: 62px; border-radius: 7px; border: 1px solid var(--rule); background: var(--inset);
  display: grid; place-content: center; gap: 3px;
}
.channel-button.active.tone-a { border-color: #5b8e96; background: #243236; }
.channel-button.active.tone-b { border-color: #965b66; background: #36242a; }
.channel-letter { font: 700 20px var(--mono); }
.channel-button small { color: var(--soft); font-size: 10px; }
.channel-button.active.tone-a .channel-letter { color: #85cbd5; }
.channel-button.active.tone-b .channel-letter { color: #ec9fa9; }

.blind-controls { display: flex; align-items: center; gap: 8px; }
.play-button-sm {
  width: 38px; height: 38px; border-radius: 50%; border: none; background: var(--gold); color: #241e12;
  display: grid; place-items: center; flex-shrink: 0;
}
.play-button-sm:hover { background: #fad48d; }
.icon-button-sm {
  width: 34px; height: 34px; border-radius: 5px; border: 1px solid var(--rule);
  background: transparent; color: var(--muted); display: grid; place-items: center;
}
.blind-scrub { flex: 1; min-width: 0; }

.mode-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mode-button.enabled { background: #302c21; border-color: #8b7041; color: var(--gold); }
.mode-button svg { color: var(--gold); }

.calibration { border: 1px solid var(--rule); border-radius: 6px; padding: 8px 10px; background: var(--inset); }
.calibration summary { font-size: 12px; color: var(--muted); cursor: pointer; }
.calibration label { display: grid; gap: 4px; margin-top: 9px; font-size: 11px; color: var(--muted); }
.calibration strong { color: var(--gold); }
.warning-list { display: grid; gap: 5px; max-height: 118px; overflow: auto; }
.warning-list li {
  font-size: 10.5px; line-height: 1.55; color: #e3c08a; background: #2c281d;
  border-left: 2px solid var(--gold); border-radius: 3px; padding: 5px 7px;
}
.reveal-button { width: 100%; background: #302c21; border-color: #8b7041; color: var(--gold); }
.reveal-map { display: grid; gap: 7px; border: 1px dashed #5d4c32; border-radius: 6px; padding: 10px; font-size: 11.5px; }
.reveal-map p { display: flex; align-items: center; gap: 8px; }
.reveal-enter-active, .reveal-leave-active { transition: opacity 180ms ease; }
.reveal-enter-from, .reveal-leave-to { opacity: 0; }
</style>
