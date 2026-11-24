<script setup lang="ts">
import type { AudioSegment } from '../model/types'
import { clockLabel } from '../../../shared/time'

const props = defineProps<{
  segments: AudioSegment[]
  duration: number
  position: number
  channel: 'X' | 'Y'
  active: boolean
  revealed: boolean
}>()

const kindLabel: Record<AudioSegment['kind'], string> = {
  soft: '轻唱',
  plosive: '爆破',
  gap: '漏唱',
  silence: '安静',
  reliable: '可靠发声',
}
</script>

<template>
  <div class="evidence-track" :class="{ inactive: !props.active }" :aria-label="`通道 ${channel} 片段证据`">
    <div class="evidence-head">
      <span :class="channel === 'X' ? 'slot-a' : 'slot-b'">{{ channel }}</span>
      <small class="mono subdued">{{ clockLabel(position, true) }} / {{ clockLabel(duration, true) }}</small>
    </div>
    <div class="evidence-row">
      <button v-for="segment in props.segments" :key="segment.id" type="button" class="evidence-chip"
        :class="'kind-' + segment.kind"
        :style="{ left: (segment.start / duration * 100) + '%', width: Math.max(1.2, (segment.end - segment.start) / duration * 100) + '%' }"
        :title="`${kindLabel[segment.kind]} ${segment.start.toFixed(2)}–${segment.end.toFixed(2)}s\n增益 ×${segment.gain.toFixed(2)}${segment.reason ? `\n${segment.reason}` : ''}`">
        <span>{{ kindLabel[segment.kind] }}</span>
      </button>
      <i class="playhead" :style="{ left: (position / duration * 100) + '%' }" aria-hidden="true" />
    </div>
    <ul v-if="revealed" class="evidence-legend">
      <li v-for="segment in props.segments" :key="segment.id" :class="['kind-' + segment.kind]">
        <strong>{{ kindLabel[segment.kind] }}</strong>
        <span class="mono">{{ segment.start.toFixed(2) }}–{{ segment.end.toFixed(2) }}s · ×{{ segment.gain.toFixed(2) }}</span>
        <small v-if="segment.reason">{{ segment.reason }}</small>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.evidence-track { display: grid; gap: 6px; }
.evidence-track.inactive { opacity: .55; }
.evidence-head { display: flex; align-items: center; gap: 8px; }
.evidence-head span {
  width: 20px; height: 20px; border-radius: 4px; display: inline-grid; place-items: center;
  font: 700 11px var(--mono); background: #2c3335;
}
.evidence-head .slot-b { background: #382a2d; }
.evidence-row { position: relative; height: 30px; border-radius: 5px; background: var(--inset); border: 1px solid var(--rule); }
.evidence-chip {
  position: absolute; top: 3px; height: 22px; padding: 0 3px; border: none; border-radius: 3px;
  display: grid; place-items: center; overflow: hidden; min-width: 0;
}
.evidence-chip span { font-size: 9px; white-space: nowrap; color: #1d2019; font-weight: 700; }
.kind-soft { background: #9cc7e0; }
.kind-reliable { background: #b8dc9d; }
.kind-plosive { background: #f09982; }
.kind-gap { background: #6b5f8f; }
.kind-gap span, .kind-silence span { color: var(--paper); }
.kind-silence { background: #4a4e42; }
.playhead {
  position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--gold);
  box-shadow: 0 0 6px rgba(229, 189, 112, .8); pointer-events: none;
}
.evidence-legend { display: grid; gap: 4px; max-height: 150px; overflow: auto; }
.evidence-legend li {
  display: grid; gap: 2px; padding: 5px 7px; border-radius: 4px; background: var(--inset);
  border-left: 3px solid var(--rule); font-size: 10.5px;
}
.evidence-legend li.kind-soft { border-left-color: #9cc7e0; }
.evidence-legend li.kind-reliable { border-left-color: var(--green); }
.evidence-legend li.kind-plosive { border-left-color: var(--coral); }
.evidence-legend li.kind-gap { border-left-color: #6b5f8f; }
.evidence-legend small { color: var(--soft); line-height: 1.5; }
.evidence-legend .mono { color: var(--muted); font-size: 9.5px; }
</style>
