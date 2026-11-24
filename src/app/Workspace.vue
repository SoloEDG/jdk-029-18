<script setup lang="ts">
import { computed, ref } from 'vue'
import { AudioLines, Ear, Headphones } from '@lucide/vue'
import { songs, SongCatalog, SongHeading, TransportBar } from '../features/playback'
import { LyricStage, PhraseList } from '../features/lyrics'
import { RecordControls } from '../features/capture'
import { PitchPanel } from '../features/pitch'
import { ReviewPanel } from '../features/review'
import { BlindTestPanel } from '../features/blindtest'
import { useWorkspace } from './useWorkspace'

const {
  transport, lyrics, pitch, review, capture, graphRange, graphPosition,
  selectLine, adjacent, selectSong, seek, toggleLoop, togglePlay, toggleRecording, listen,
} = useWorkspace()

const rightTab = ref<'review' | 'blind'>('review')
const takeOptions = computed(() => review.visible.value.map((take, index) => ({
  id: take.id,
  label: `录音 ${review.visible.value.length - index}`,
  audio: take.audio,
})))
</script>

<template>
  <header class="app-header">
    <div class="app-header-inner">
      <span class="brand-mark"><AudioLines :size="22" :stroke-width="2.1" /></span>
      <div class="brand-name"><strong>夜航练习室</strong><span>NIGHT SESSION</span></div>
    </div>
  </header>
  <main class="workspace">
    <aside class="left-rail">
      <SongCatalog :songs="songs" :current="transport.song.value" @select="selectSong" />
      <PhraseList :lines="transport.song.value.lines" :selected="lyrics.selected.value" :active="lyrics.active.value" @select="selectLine" />
    </aside>
    <div class="workbench">
      <SongHeading :song="transport.song.value" />
      <LyricStage :selected="lyrics.selected.value" :active="lyrics.active.value" :upcoming="lyrics.upcoming.value"
        :playing="transport.isPlaying.value" :progress="lyrics.lineProgress.value" />
      <PitchPanel :notes="transport.song.value.notes" :position="graphPosition" :range="graphRange"
        :latest="capture.status.value === 'recording' ? pitch.latest.value : null"
        :live="capture.status.value === 'recording' ? pitch.points.value : []"
        :take-a="review.slots.value[0]?.pitch ?? []" :take-b="review.slots.value[1]?.pitch ?? []" />
      <TransportBar :song="transport.song.value" :position="transport.position.value" :playing="transport.isPlaying.value"
        :loop="transport.loop.value" :volume="transport.volume.value" :issue="transport.issue.value"
        @toggle="togglePlay" @previous="adjacent(-1)" @next="adjacent(1)" @loop="toggleLoop"
        @seek="seek" @volume="transport.setVolume" />
      <RecordControls :status="capture.status.value" :issue="capture.issue.value" :level="capture.level.value"
        :selected="lyrics.selected.value" @toggle="toggleRecording" />
    </div>
    <aside class="right-rail">
      <div class="rail-tabs" role="tablist">
        <button type="button" role="tab" :aria-selected="rightTab === 'review'" :class="{ active: rightTab === 'review' }"
          @click="rightTab = 'review'"><Headphones :size="15" /> 练习回顾</button>
        <button type="button" role="tab" :aria-selected="rightTab === 'blind'" :class="{ active: rightTab === 'blind' }"
          @click="rightTab = 'blind'"><Ear :size="15" /> 匿名对照</button>
      </div>
      <ReviewPanel v-show="rightTab === 'review'" :takes="review.visible.value" :slots="review.slots.value" :active-id="review.playingId.value"
        :selected="lyrics.selected.value" :notes="transport.song.value.notes" :issue="review.issue.value"
        @listen="listen" @choose="review.choose" />
      <BlindTestPanel v-show="rightTab === 'blind'" :take-options="takeOptions" @issue="message => (review.issue.value = message)" />
    </aside>
  </main>
</template>
