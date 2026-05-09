// Dump per-layer SVGs as a grid PNG so we can see what each shape looks like.
import { readFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const buf = await readFile('pizza.png')
const fd  = new FormData()
fd.append('image', new Blob([buf], { type: 'image/png' }), 'pizza.png')

const res = await fetch('http://localhost:3000/api/convert', { method: 'POST', body: fd })
const result = await res.json()

const layers = result.layers
const palette = result.palette
console.log(`${layers.length} shapes`)

const TILE = 200
const COLS = 6
const ROWS = Math.ceil(layers.length / COLS)
const W = COLS * (TILE + 4) + 4
const H = ROWS * (TILE + 4) + 4

const composites = []
for (let i = 0; i < layers.length; i++) {
  const c = i % COLS, r = (i / COLS) | 0
  const png = await sharp(Buffer.from(layers[i]))
    .resize(TILE, TILE, { fit: 'inside', background: '#222' })
    .flatten({ background: '#222' })
    .png()
    .toBuffer()
  composites.push({ input: png, left: 4 + c * (TILE + 4), top: 4 + r * (TILE + 4) })
}

const grid = await sharp({
  create: { width: W, height: H, channels: 3, background: '#222' },
}).composite(composites).png().toBuffer()

await writeFile('tmp/layers-grid.png', grid)
console.log('palette:', palette.join(' '))
console.log('wrote tmp/layers-grid.png')
