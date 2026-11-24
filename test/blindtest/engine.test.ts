import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { analyze } from '../../src/features/blindtest/lib/analysis.ts'
import { BlindEngine } from '../../src/features/blindtest/lib/engine.ts'
import { buildAutomation, gainAt, planGains } from '../../src/features/blindtest/lib/gain.ts'
import { buildPlan } from '../../src/features/blindtest/lib/matching.ts'
import { buildFixturePair } from '../../src/features/blindtest/lib/fixture.ts'
import type { BlindTake } from '../../src/features/blindtest/model/types.ts'
import { MockClock, MockGainNode } from './mock-clock.ts'

const { takeA, takeB } = buildFixturePair()
const blindA: BlindTake = { id: 'a', label: '录音A', samples: takeA.samples, sampleRate: takeA.sampleRate, duration: takeA.duration }
const blindB: BlindTake = { id: 'b', label: '录音B', samples: takeB.samples, sampleRate: takeB.sampleRate, duration: takeB.duration }

function setup() {
  const clock = new MockClock()
  const gainNodes: MockGainNode[] = []
  const originalCreateGain = clock.createGain.bind(clock)
  clock.createGain = () => {
    const node = originalCreateGain()
    gainNodes.push(node)
    return node
  }
  const engine = new BlindEngine({ clock: clock as never, startDelay: 0 })
  const plan = planGains(buildPlan(analyze(blindA), analyze(blindB)))
  engine.load('X', plan.a)
  engine.load('Y', plan.b)
  return { clock, engine, plan, gainNodes }
}

/** 只统计仍在链路中的增益节点（已 disconnect 的旧节点不计）。 */
const live = (nodes: MockGainNode[]) => nodes.filter(node => !node.disconnected)

describe('盲听引擎：快切 / 暂停 / 揭晓后原声复听', () => {
  it('播放后 X/Y 双路 source 同时起播，仅激活路有增益', () => {
    const { clock, engine, gainNodes } = setup()
    engine.play()
    clock.advance(0.2)
    assert.equal(clock.destination.sources.length, 2, '两条路同时存在，切换时不重启 source')
    assert.deepEqual(clock.destination.sources.map(source => source.started[0].offset), [0, 0])
    const [gainX, gainY] = live(gainNodes)
    assert.ok(gainX.gain.valueAt(clock.currentTime) > 0)
    assert.equal(gainY.gain.valueAt(clock.currentTime), 0)
  })

  it('快切只交换增益、不移动播放头且不创建新 source', () => {
    const { clock, engine, plan, gainNodes } = setup()
    engine.play()
    clock.advance(1.5)
    const sourceCount = clock.destination.sources.length
    const positionBefore = engine.position()
    engine.switchTo('Y')
    assert.equal(clock.destination.sources.length, sourceCount, '快切不得创建新 source')
    assert.ok(Math.abs(engine.position() - positionBefore) < 1e-9, '同一歌时播放头不动')
    clock.advance(0.1)
    const [gainX, gainY] = live(gainNodes)
    const expectedY = gainAt(buildAutomation(plan.b, 'calibrated'), engine.position())
    assert.equal(engine.channel, 'Y')
    assert.equal(gainX.gain.valueAt(clock.currentTime), 0, '旧路淡出到零')
    assert.ok(Math.abs(gainY.gain.valueAt(clock.currentTime) - expectedY) < 0.02, '新路按同一歌时增益复现')
    engine.switchTo('X')
    clock.advance(0.1)
    assert.ok(gainX.gain.valueAt(clock.currentTime) > 0)
    assert.equal(gainY.gain.valueAt(clock.currentTime), 0)
  })

  it('暂停冻结播放头，续播在同一歌时恢复自动化', () => {
    const { clock, engine } = setup()
    engine.play()
    clock.advance(2.3)
    const frozen = engine.position()
    engine.pause()
    assert.equal(engine.isPlaying, false)
    clock.advance(5)
    assert.ok(Math.abs(engine.position() - frozen) < 1e-9, '暂停期间播放头不漂移')
    engine.play()
    clock.advance(0.4)
    assert.ok(Math.abs(engine.position() - (frozen + 0.4)) < 1e-6)
    const lastStart = clock.destination.sources.at(-1)!.started.at(-1)!
    assert.ok(Math.abs(lastStart.offset - frozen) < 1e-6, '续播 offset 等于冻结点')
  })

  it('揭晓切到原声后增益恒为 1，切回校准后同歌时增益可复现', () => {
    const { clock, engine, plan, gainNodes } = setup()
    engine.play()
    clock.advance(1.0)
    const calibratedPoints = buildAutomation(plan.a, 'calibrated')
    const calibratedBefore = gainAt(calibratedPoints, engine.position())
    assert.ok(calibratedBefore !== 1, '校准模式在该时刻应有补增益')
    engine.setMode('raw')
    clock.advance(0.3)
    const activeInRaw = live(gainNodes).find(node => node.gain.valueAt(clock.currentTime) > 0)!
    assert.equal(activeInRaw.gain.valueAt(clock.currentTime), 1, '激活路在原声模式逐点等于 1，不做任何处理')
    engine.setMode('calibrated')
    clock.advance(0.3)
    const [gainX] = live(gainNodes)
    assert.ok(Math.abs(gainX.gain.valueAt(clock.currentTime) - gainAt(calibratedPoints, engine.position())) < 0.02)
  })

  it('从头重播后自动化与首次播放一致', () => {
    const { clock, engine, plan } = setup()
    engine.play()
    clock.advance(3.0)
    engine.restart()
    assert.ok(Math.abs(engine.position()) < 1e-9)
    engine.play()
    clock.advance(0.5)
    assert.ok(Math.abs(engine.position() - 0.5) < 1e-6)
    const points = buildAutomation(plan.a, 'calibrated')
    assert.ok(Math.abs(engine.activeGainAt(0.5) - gainAt(points, 0.5)) < 1e-9)
  })

  it('停止态切换通道不发声，播放后从所选通道起播', () => {
    const { engine } = setup()
    engine.switchTo('Y')
    assert.equal(engine.channel, 'Y')
    assert.equal(engine.isPlaying, false)
    engine.play()
    assert.equal(engine.channel, 'Y')
  })
})
