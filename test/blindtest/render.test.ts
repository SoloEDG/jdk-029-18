import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { analyze } from '../../src/features/blindtest/lib/analysis.ts'
import { gainToDb, planGains } from '../../src/features/blindtest/lib/gain.ts'
import { buildPlan } from '../../src/features/blindtest/lib/matching.ts'
import { buildFixturePair } from '../../src/features/blindtest/lib/fixture.ts'
import { renderSwitch, renderTake } from '../../src/features/blindtest/lib/render.ts'
import type { BlindTake } from '../../src/features/blindtest/model/types.ts'

const { takeA, takeB } = buildFixturePair()
const blindA: BlindTake = { id: 'a', label: '录音A', samples: takeA.samples, sampleRate: takeA.sampleRate, duration: takeA.duration }
const blindB: BlindTake = { id: 'b', label: '录音B', samples: takeB.samples, sampleRate: takeB.sampleRate, duration: takeB.duration }
const plan = planGains(buildPlan(analyze(blindA), analyze(blindB)))

describe('样本级渲染：实际听到的输出可复现、原声不被改写', () => {
  it('raw 模式渲染与输入原声逐采样相同', () => {
    for (const [analysis, source] of [[plan.a, blindA], [plan.b, blindB]] as const) {
      const rendered = renderTake(analysis, 'X', 'raw')
      assert.equal(rendered.samples.length, source.samples.length)
      let mismatch = 0
      for (let index = 0; index < source.samples.length; index++) {
        if (rendered.samples[index] !== source.samples[index]) mismatch++
      }
      assert.equal(mismatch, 0, '原声复听必须零改写')
    }
  })

  it('校准渲染不削顶：所有输出采样低于峰值上限', () => {
    const ceiling = 10 ** (-1 / 20)
    for (const analysis of [plan.a, plan.b]) {
      const rendered = renderTake(analysis, 'X', 'calibrated')
      let peak = 0
      for (const value of rendered.samples) peak = Math.max(peak, Math.abs(value))
      assert.ok(peak <= ceiling + 1e-9, `峰值 ${peak.toFixed(4)} 越过上限`)
    }
  })

  it('轻唱段渲染后整体抬高，可靠发声调整限制在 ±3dB', () => {
    const rendered = renderTake(plan.a, 'X', 'calibrated')
    const soft = plan.a.segments.find(segment => segment.kind === 'soft')!
    const reliable = plan.a.segments.find(segment => segment.kind === 'reliable')!
    const energy = (samples: Float32Array, from: number, to: number) => {
      const start = Math.round(from * plan.a.take.sampleRate)
      const end = Math.round(to * plan.a.take.sampleRate)
      let sum = 0
      for (let index = start; index < end; index++) sum += samples[index] ** 2
      return Math.sqrt(sum / (end - start))
    }
    assert.ok(energy(rendered.samples, soft.start + 0.2, soft.end - 0.2)
      > energy(plan.a.take.samples, soft.start + 0.2, soft.end - 0.2), '轻唱段渲染能量必须高于原声')
    assert.ok(Math.abs(gainToDb(reliable.gain)) <= 3.001)
  })

  it('X→Y 与 Y→X 两次快切在同一歌时的采样增益完全一致（来回切换可复现）', () => {
    const duration = 6
    const rate = blindA.sampleRate
    const first = renderSwitch({ X: plan.a, Y: plan.b }, ['X', 'Y'], 2.5, duration, rate)
    const second = renderSwitch({ X: plan.a, Y: plan.b }, ['Y', 'X'], 2.5, duration, rate)
    // 两条切换序列在 2.5s 之后都应稳定在「切换后通道」的独立渲染曲线上
    const soloAfter = renderTake(plan.b, 'Y', 'calibrated').samples
    let delta = 0
    for (let index = Math.round(2.6 * rate); index < Math.round(3.5 * rate); index++) {
      delta = Math.max(delta, Math.abs(first[index] - soloAfter[index]))
    }
    assert.ok(delta < 1e-6, `快切后与独立渲染偏差 ${delta}`)
    const soloX = renderTake(plan.a, 'X', 'calibrated').samples
    let deltaReverse = 0
    for (let index = Math.round(2.6 * rate); index < Math.round(3.5 * rate); index++) {
      deltaReverse = Math.max(deltaReverse, Math.abs(second[index] - soloX[index]))
    }
    assert.ok(deltaReverse < 1e-6, '反向快切同样可复现')
  })

  it('漏唱段在渲染输出中保持本底噪声水平，不被补声', () => {
    const rendered = renderTake(plan.a, 'X', 'calibrated')
    const gap = plan.a.segments.find(segment => segment.kind === 'gap')!
    const center = Math.round(((gap.start + gap.end) / 2) * plan.a.take.sampleRate)
    const window = rendered.samples.slice(center - 100, center + 100)
    const rms = Math.sqrt(window.reduce((sum, value) => sum + value * value, 0) / window.length)
    const original = plan.a.take.samples.slice(center - 100, center + 100)
    const originalRms = Math.sqrt(original.reduce((sum, value) => sum + value * value, 0) / original.length)
    assert.ok(Math.abs(rms - originalRms) < 1e-7, '漏唱段不得补声')
  })
})
