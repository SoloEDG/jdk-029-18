import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { analyze } from '../../src/features/blindtest/lib/analysis.ts'
import { buildPlan } from '../../src/features/blindtest/lib/matching.ts'
import { buildAutomation, dbToGain, gainAt, gainToDb, planGains, preserveAccents } from '../../src/features/blindtest/lib/gain.ts'
import { decodeWav } from '../../src/features/blindtest/lib/wav.ts'
import { buildFixturePair, encodeWav } from '../../src/features/blindtest/lib/fixture.ts'
import type { BlindTake } from '../../src/features/blindtest/model/types.ts'

const { takeA, takeB } = buildFixturePair()
const blindA: BlindTake = { id: 'a', label: '录音A', samples: takeA.samples, sampleRate: takeA.sampleRate, duration: takeA.duration }
const blindB: BlindTake = { id: 'b', label: '录音B', samples: takeB.samples, sampleRate: takeB.sampleRate, duration: takeB.duration }

describe('片段分析：长轻唱 / 错位爆破音 / 漏唱', () => {
  it('两支录音都切出两段较长轻唱', () => {
    for (const take of [blindA, blindB]) {
      const result = analyze(take)
      const soft = result.segments.filter(segment => segment.kind === 'soft')
      assert.ok(soft.length >= 2, `轻唱片段数量 ${soft.length}`)
      assert.ok(soft.every(segment => segment.end - segment.start >= 0.6), '短轻唱必须标记证据不足而非误判')
      const totalSoft = soft.reduce((sum, segment) => sum + segment.end - segment.start, 0)
      assert.ok(totalSoft >= 3.5, `轻唱总时长 ${totalSoft.toFixed(2)}s 应足够长`)
    }
  })

  it('爆破音落在合成位置且与另一支错位超过 120ms', () => {
    const resultA = analyze(blindA)
    const resultB = analyze(blindB)
    const plosiveA = resultA.segments.find(segment => segment.kind === 'plosive')
    const plosiveB = resultB.segments.find(segment => segment.kind === 'plosive')
    assert.ok(plosiveA && plosiveB, '两支都应识别出爆破音')
    assert.ok(Math.abs(plosiveA.start - takeA.plosiveAt) < 0.08)
    assert.ok(Math.abs(plosiveB.start - takeB.plosiveAt) < 0.08)
    assert.ok(Math.abs(plosiveA.start - plosiveB.start) > 0.12, '爆破音必须错位到匹配容差之外')
  })

  it('漏唱段被识别为 gap 且首尾安静归为 silence', () => {
    const resultA = analyze(blindA)
    const gapA = resultA.segments.find(segment => segment.kind === 'gap')
    assert.ok(gapA, 'A 应有漏唱段')
    assert.ok(gapA.start >= takeA.gapWindow[0] - 0.05 && gapA.end <= takeA.gapWindow[1] + 0.05)
    const resultB = analyze(blindB)
    const gapB = resultB.segments.find(segment => segment.kind === 'gap')
    assert.ok(gapB && Math.abs(gapB.start - takeB.gapWindow[0]) < 0.1)
    assert.notDeepEqual(
      resultA.segments.filter(s => s.kind === 'gap').map(s => s.start),
      resultB.segments.filter(s => s.kind === 'gap').map(s => s.start),
      '两支漏唱位置不同',
    )
  })

  it('WAV 往返解码保持采样数与时长', () => {
    const wav = encodeWav(blindA.samples, blindA.sampleRate)
    const decoded = decodeWav(wav)
    assert.equal(decoded.sampleRate, blindA.sampleRate)
    assert.equal(decoded.samples.length, blindA.samples.length)
    assert.ok(Math.abs(decoded.duration - blindA.duration) < 0.01)
    let delta = 0
    for (let index = 0; index < decoded.samples.length; index += 97) delta = Math.max(delta, Math.abs(decoded.samples[index] - blindA.samples[index]))
    assert.ok(delta < 0.001, '16-bit 量化误差应很小')
  })
})

describe('匹配：可配对片段与证据不足说明', () => {
  const plan = buildPlan(analyze(blindA), analyze(blindB))

  it('长轻唱段在 ±120ms 容差内配对，错位爆破音与漏唱不配对', () => {
    assert.ok(plan.pairs.length >= 2, `匹配对数 ${plan.pairs.length}`)
    assert.ok(plan.pairs.every(pair => Math.abs(pair.offsetSeconds) <= 0.12))
    const matchedKindsA = plan.pairs.map(pair => plan.a.segments.find(s => s.id === pair.aSegmentId)?.kind)
    assert.ok(matchedKindsA.includes('soft'))
    const plosiveA = plan.a.segments.find(segment => segment.kind === 'plosive')!
    const plosiveB = plan.b.segments.find(segment => segment.kind === 'plosive')!
    assert.ok(!plan.matchedAIds.has(plosiveA.id) && !plan.matchedBIds.has(plosiveB.id), '错位爆破音不得强行配对')
    assert.ok(plosiveA.reason.includes('爆破音') && plosiveB.reason.includes('爆破音'))
    const gapA = plan.a.segments.find(segment => segment.kind === 'gap')!
    assert.ok(!plan.matchedAIds.has(gapA.id))
    assert.ok(plan.warnings.some(text => text.includes('保留原声')))
  })
})

describe('增益规划：轻声可听、峰值不失真、重音不被抹平', () => {
  const plan = planGains(buildPlan(analyze(blindA), analyze(blindB)), { targetQuietDb: -30, ceilingDb: -1 })

  it('轻声段被补到可听阈值附近且受峰值上限钳制', () => {
    for (const analysis of [plan.a, plan.b]) {
      for (const segment of analysis.segments.filter(s => s.kind === 'soft')) {
        assert.ok(segment.gain >= 1, '轻声只能向上补，不能整体调低到更轻')
        const resultingRmsDb = gainToDb(segment.rms * segment.gain)
        const capped = segment.reason.includes('钳制')
        if (capped) {
          // 证据充分但峰值会失真：必须按峰值上限钳制，并显式说明原因。
          assert.ok(Math.abs(gainToDb(segment.peak * segment.gain) - (-1)) < 0.5, '钳制时贴住峰值上限')
          assert.ok(resultingRmsDb > gainToDb(segment.rms), '即便钳制也必须比原声响')
        } else {
          assert.ok(resultingRmsDb >= -33, `补后 RMS ${resultingRmsDb.toFixed(1)}dB 应接近 -30dB 可听阈值`)
        }
        assert.ok(segment.peak * segment.gain <= dbToGain(-1) + 1e-9, '补增益后峰值不得越过上限')
      }
    }
  })

  it('爆破音不抬升；漏唱与首尾安静保持原声', () => {
    for (const analysis of [plan.a, plan.b]) {
      const plosive = analysis.segments.find(segment => segment.kind === 'plosive')!
      assert.ok(plosive.gain <= 1, '爆破音增益不得大于 1')
      for (const segment of analysis.segments.filter(s => s.kind === 'gap' || s.kind === 'silence')) {
        assert.equal(segment.gain, 1)
      }
    }
  })

  it('可靠发声匹配对在 ±3dB 内对齐，B（低 6dB）得到有限补偿', () => {
    for (const pair of plan.pairs) {
      const a = plan.a.segments.find(s => s.id === pair.aSegmentId)!
      const b = plan.b.segments.find(s => s.id === pair.bSegmentId)!
      if (a.kind !== 'reliable' || b.kind !== 'reliable') continue
      assert.ok(Math.abs(gainToDb(a.gain)) <= 3.001 && Math.abs(gainToDb(b.gain)) <= 3.001)
      const afterA = gainToDb(a.rms * a.gain)
      const afterB = gainToDb(b.rms * b.gain)
      assert.ok(Math.abs(afterA - afterB) <= 1, '对齐后两侧电平差应收敛到 1dB 内')
    }
  })

  it('重音次序校验：人为反相增益会被回退', () => {
    const analysis = analyze(blindA)
    const voiced = analysis.segments.filter(s => s.kind === 'soft' || s.kind === 'reliable')
    assert.ok(voiced.length >= 2)
    voiced[0].gain = 1
    voiced[1].gain = dbToGain(20)
    const before = voiced[1].gain
    preserveAccents(analysis)
    assert.ok(voiced[1].gain < before, '违反原有重音次序的增益必须被压回')
  })

  it('自动化只含恒定段与线性过渡，raw 模式完全等于原声', () => {
    const calibrated = buildAutomation(plan.a, 'calibrated')
    assert.ok(calibrated.length >= 2)
    const first = plan.a.segments[0]
    assert.equal(gainAt(calibrated, first.start + 0.02), first.gain)
    const raw = buildAutomation(plan.a, 'raw')
    assert.deepEqual(raw, [{ time: 0, gain: 1 }])
    assert.equal(gainAt(raw, 3.21), 1)
  })
})
