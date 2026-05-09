// Zoom into specific regions of the original vs rendered to spot fine diffs.
import { readFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const original = await sharp('pizza.png').resize(1200, 1200, { fit: 'inside' }).png().toBuffer()
const rendered = await sharp(await readFile('tmp/pizza.svg'))
  .resize(1200, 1200, { fit: 'inside' })
  .png()
  .toBuffer()

const oMeta = await sharp(original).metadata()
const rMeta = await sharp(rendered).metadata()

const regions = [
  { name: 'top-pepperoni',  x: 280, y: 250, w: 350, h: 350 },
  { name: 'bottom-pepperoni', x: 350, y: 700, w: 350, h: 350 },
  { name: 'face',           x: 400, y: 450, w: 350, h: 250 },
  { name: 'crust-top',      x: 200, y: 100, w: 800, h: 220 },
]

for (const r of regions) {
  const ox = Math.min(r.x, oMeta.width - r.w)
  const oy = Math.min(r.y, oMeta.height - r.h)
  const o = await sharp(original).extract({ left: ox, top: oy, width: r.w, height: r.h }).png().toBuffer()
  const v = await sharp(rendered).extract({ left: ox, top: oy, width: r.w, height: r.h }).png().toBuffer()
  const cmp = await sharp({
    create: { width: r.w * 2 + 8, height: r.h, channels: 3, background: '#222' },
  }).composite([
    { input: o, left: 0, top: 0 },
    { input: v, left: r.w + 8, top: 0 },
  ]).png().toBuffer()
  await writeFile(`tmp/zoom-${r.name}.png`, cmp)
}
console.log('wrote 4 zoom comparisons')
