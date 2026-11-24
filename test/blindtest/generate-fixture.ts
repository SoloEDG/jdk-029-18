/**
 * 生成两支合成轻唱录音到 public/media/blind-demo/，供页面里的「载入示例对照」使用。
 * 运行：npm run fixture:blind
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFixturePair, encodeWav } from '../../src/features/blindtest/lib/fixture.ts'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../../public/media/blind-demo')
mkdirSync(outDir, { recursive: true })
const { takeA, takeB } = buildFixturePair()
for (const take of [takeA, takeB]) {
  const wav = encodeWav(take.samples, take.sampleRate)
  const file = resolve(outDir, `${take.name}.wav`)
  writeFileSync(file, wav)
  console.log(`written ${file} (${wav.length} bytes)`)
}
writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify({
  sampleRate: takeA.sampleRate,
  duration: takeA.duration,
  a: { file: `${takeA.name}.wav`, plosiveAt: takeA.plosiveAt, gapWindow: takeA.gapWindow },
  b: { file: `${takeB.name}.wav`, plosiveAt: takeB.plosiveAt, gapWindow: takeB.gapWindow },
}, null, 2))
console.log(`manifest written to ${outDir}/manifest.json`)
