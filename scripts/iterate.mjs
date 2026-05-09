// Iteration helper: POST pizza.png to the local /api/convert, render the
// resulting SVG via sharp, and emit a side-by-side comparison image so I can
// visually diff each pipeline tweak against the original.
import { readFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const SRC     = 'pizza.png'
const OUT_SVG = 'tmp/pizza.svg'
const OUT_PNG = 'tmp/pizza-rendered.png'
const OUT_CMP = 'tmp/pizza-compare.png'

const buf = await readFile(SRC)
const fd  = new FormData()
fd.append('image', new Blob([buf], { type: 'image/png' }), 'pizza.png')

console.time('convert')
const res = await fetch('http://localhost:3000/api/convert', { method: 'POST', body: fd })
console.timeEnd('convert')
if (!res.ok) {
  const txt = await res.text()
  console.error('convert failed:', res.status, txt)
  process.exit(1)
}
const result = await res.json()
console.log(`shapes: ${result.layers.length}, w×h: ${result.width}×${result.height}`)
await writeFile(OUT_SVG, result.svg)

const original = await sharp(SRC).resize(900, 900, { fit: 'inside' }).png().toBuffer()
const rendered = await sharp(Buffer.from(result.svg))
  .resize(900, 900, { fit: 'inside' })
  .png()
  .toBuffer()
await writeFile(OUT_PNG, rendered)

const meta = await sharp(original).metadata()
const W = meta.width, H = meta.height
const cmp = await sharp({
  create: { width: W * 2 + 8, height: H, channels: 3, background: '#222' },
}).composite([
  { input: original, left: 0,     top: 0 },
  { input: rendered, left: W + 8, top: 0 },
]).png().toBuffer()
await writeFile(OUT_CMP, cmp)

console.log(`wrote ${OUT_SVG}, ${OUT_PNG}, ${OUT_CMP}`)
