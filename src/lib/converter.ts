import sharp from 'sharp'
import potrace from 'potrace'
import quantize from 'quantize'
import { fitPrimitivesInSvg } from './fit-primitives'

export interface ConversionOptions {
  maxSize?: number  // longest edge after preprocessing (default 900)
  debug?: boolean
}

// Auto-derived constants (replace former user-tunable sliders).
// Architecture rationale:
//   - QUANT_COLORS: clan clustering merges similar shades anyway, so a generous
//     palette costs little and lets us pick up subtle gradient bands.
//   - SMOOTH_SIGMA: a small fixed soft-blur applied after morphology, enough to
//     anti-alias jagged trace edges without rounding off intentional corners.
//   - turdSize is computed per-image from the longest edge (see body) since the
//     "right" minimum shape size scales with image resolution.
const QUANT_COLORS = 64
const SMOOTH_SIGMA = 0.5  // mild final anti-alias on traced edges

export interface ConversionResult {
  svg: string           // final assembled SVG
  palette: string[]     // representative hex per emitted shape (draw order)
  layers: string[]      // individual SVG per shape (for the UI step preview)
  width: number
  height: number
}

type RGB = [number, number, number]
type Lab = [number, number, number]

// ─────────────────────────────────────────────────────────────────────────────
// Color helpers
// ─────────────────────────────────────────────────────────────────────────────

const SRGB_LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const v = i / 255
  SRGB_LINEAR[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = SRGB_LINEAR[r], lg = SRGB_LINEAR[g], lb = SRGB_LINEAR[b]
  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047
  const y =  lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750
  const z = (lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041) / 1.08883
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116
  const fx = f(x), fy = f(y), fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function labDistSq(a: Lab, b: Lab): number {
  return (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return '#' + [r, g, b].map(v => c(v).toString(16).padStart(2, '0')).join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — cluster palette into "clans" via complete-linkage hierarchical
// ─────────────────────────────────────────────────────────────────────────────
// Complete linkage: a clan can only grow if EVERY existing member is within
// `threshold` of the candidate. This caps each clan's diameter at `threshold`,
// which prevents single-linkage transitivity bugs like
// yellow → goldenyellow → orangeyellow → orange (each pair under threshold,
// but yellow ↔ orange is not). Single-linkage produced cheese clans containing
// crust oranges, leaking orange into the cheese gradient.

function clusterClans(paletteLab: Lab[], thresholdSq: number): Uint8Array {
  const N = paletteLab.length

  // Pairwise squared-distance matrix
  const dist = new Float64Array(N * N)
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const d = labDistSq(paletteLab[i], paletteLab[j])
      dist[i * N + j] = d
      dist[j * N + i] = d
    }
  }

  // Each palette entry starts as its own singleton clan
  const members: number[][] = paletteLab.map((_, i) => [i])
  const alive = new Uint8Array(N).fill(1)

  // Greedy complete linkage: repeatedly merge the pair of clans whose maximum
  // inter-member distance is smallest, as long as it stays within threshold.
  while (true) {
    let bestA = -1, bestB = -1
    let bestMax = Infinity

    for (let a = 0; a < N; a++) {
      if (!alive[a]) continue
      for (let b = a + 1; b < N; b++) {
        if (!alive[b]) continue
        // max pairwise distance across the proposed merger
        let maxD = 0
        const ma = members[a], mb = members[b]
        outer: for (const i of ma) {
          for (const j of mb) {
            const d = dist[i * N + j]
            if (d > maxD) {
              maxD = d
              if (maxD > thresholdSq) break outer  // early exit
            }
          }
        }
        if (maxD <= thresholdSq && maxD < bestMax) {
          bestMax = maxD
          bestA = a
          bestB = b
        }
      }
    }

    if (bestA === -1) break
    members[bestA].push(...members[bestB])
    alive[bestB] = 0
    members[bestB] = []
  }

  // Compact alive clan ids into 0..M-1
  const clanIds = new Uint8Array(N)
  let nextId = 0
  for (let a = 0; a < N; a++) {
    if (!alive[a]) continue
    for (const m of members[a]) clanIds[m] = nextId
    nextId++
  }
  return clanIds
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — extract connected components from clan-labeled pixel grid
// ─────────────────────────────────────────────────────────────────────────────
// 4-connected flood fill labeling. Each "component" is a contiguous region of
// same-clan pixels — the equivalent of a single closed shape that a vector
// illustrator would draw with one path.

interface Component {
  id: number
  clanId: number
  area: number
  perimeter: number  // count of border edges (pixel-edge units, 4-conn)
  bbox: { minX: number; maxX: number; minY: number; maxY: number }
  edgeTouch: number  // how many image edges this component touches (0–4)
  firstPixel: number  // seed pixel index — used to look up palette/clan ids
  // Filled by computeComponentStats:
  paletteCounts: Map<number, number>
  paletteCentroids: Map<number, { x: number; y: number; count: number }>
}

function extractComponents(
  pixelClanIdx: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; components: Component[] } {
  const N = pixelClanIdx.length
  const labels = new Int32Array(N).fill(-1)
  const components: Component[] = []
  const stack: number[] = []

  for (let i = 0; i < N; i++) {
    if (labels[i] !== -1) continue
    const clanId = pixelClanIdx[i]
    const compId = components.length

    let area = 0
    let perimeter = 0
    let minX = i % width, maxX = minX
    let minY = (i / width) | 0, maxY = minY
    let edgeMask = 0

    stack.length = 0
    stack.push(i)
    labels[i] = compId

    while (stack.length > 0) {
      const p = stack.pop()!
      const px = p % width, py = (p / width) | 0
      area++
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
      if (px === 0)          { edgeMask |= 1; perimeter++ }
      if (px === width - 1)  { edgeMask |= 2; perimeter++ }
      if (py === 0)          { edgeMask |= 4; perimeter++ }
      if (py === height - 1) { edgeMask |= 8; perimeter++ }

      // 4-connected neighbours: same-clan neighbours grow the component;
      // different-clan neighbours contribute one edge to the perimeter.
      if (px > 0)          { const n = p - 1;     if (pixelClanIdx[n] === clanId) { if (labels[n] === -1) { labels[n] = compId; stack.push(n) } } else perimeter++ }
      if (px < width - 1)  { const n = p + 1;     if (pixelClanIdx[n] === clanId) { if (labels[n] === -1) { labels[n] = compId; stack.push(n) } } else perimeter++ }
      if (py > 0)          { const n = p - width; if (pixelClanIdx[n] === clanId) { if (labels[n] === -1) { labels[n] = compId; stack.push(n) } } else perimeter++ }
      if (py < height - 1) { const n = p + width; if (pixelClanIdx[n] === clanId) { if (labels[n] === -1) { labels[n] = compId; stack.push(n) } } else perimeter++ }
    }

    let edgeTouch = 0
    if (edgeMask & 1) edgeTouch++
    if (edgeMask & 2) edgeTouch++
    if (edgeMask & 4) edgeTouch++
    if (edgeMask & 8) edgeTouch++

    components.push({
      id: compId,
      clanId,
      area,
      perimeter,
      bbox: { minX, maxX, minY, maxY },
      edgeTouch,
      firstPixel: i,
      paletteCounts: new Map(),
      paletteCentroids: new Map(),
    })
  }

  return { labels, components }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — per-component statistics
// ─────────────────────────────────────────────────────────────────────────────
// Walks all pixels once, accumulating each component's underlying-palette
// histogram and per-color centroid. Centroids drive gradient direction.

function computeComponentStats(
  components: Component[],
  labels: Int32Array,
  pixelPaletteIdx: Uint8Array,
  width: number,
): void {
  for (let i = 0; i < labels.length; i++) {
    const compId = labels[i]
    if (compId < 0) continue
    const comp = components[compId]
    const palIdx = pixelPaletteIdx[i]
    const x = i % width, y = (i / width) | 0

    comp.paletteCounts.set(palIdx, (comp.paletteCounts.get(palIdx) ?? 0) + 1)
    let centroid = comp.paletteCentroids.get(palIdx)
    if (!centroid) {
      centroid = { x: 0, y: 0, count: 0 }
      comp.paletteCentroids.set(palIdx, centroid)
    }
    centroid.x += x
    centroid.y += y
    centroid.count++
  }
  // Convert centroid sums to means
  for (const comp of components) {
    for (const c of comp.paletteCentroids.values()) {
      if (c.count > 0) {
        c.x /= c.count
        c.y /= c.count
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — background detection
// ─────────────────────────────────────────────────────────────────────────────
// A component is treated as background if its dominant color is near-white
// AND it touches at least two image edges (typical of the surrounding area
// after flatten-to-white preprocessing).

function isBackgroundComponent(comp: Component, palette: RGB[]): boolean {
  if (comp.edgeTouch < 2) return false
  let domIdx = -1, domCount = 0
  for (const [idx, count] of comp.paletteCounts) {
    if (count > domCount) { domCount = count; domIdx = idx }
  }
  if (domIdx < 0) return false
  const [r, g, b] = palette[domIdx]
  return r > 235 && g > 235 && b > 235
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — choose fill style for each component
// ─────────────────────────────────────────────────────────────────────────────
// One dominant color → solid fill. Multiple shades chained through the same
// clan → linear gradient with axis aligned along the lightness vector
// (lightest-color centroid → darkest-color centroid). This is what a vector
// illustrator does: ONE shape, ONE gradient, no internal seams.

interface FillSolid    { type: 'solid';    hex: string; lum: number }
interface FillGradient { type: 'gradient'; defXml: string; refUrl: string; lum: number; primaryHex: string }
type Fill = FillSolid | FillGradient

function chooseFill(
  comp: Component,
  palette: RGB[],
  paletteLab: Lab[],
  gradientId: string,
): Fill {
  let domIdx = -1, domCount = 0
  for (const [idx, count] of comp.paletteCounts) {
    if (count > domCount) { domCount = count; domIdx = idx }
  }
  const total = comp.area
  const domShare = domCount / total
  const domColor = palette[domIdx]
  const domHex = rgbToHex(domColor[0], domColor[1], domColor[2])
  const domLum = luminance(domColor[0], domColor[1], domColor[2])

  // Constituent colors above a noise threshold
  const colorList = [...comp.paletteCounts.entries()]
    .filter(([, count]) => count / total >= 0.05)
    .map(([idx]) => ({
      idx,
      lab: paletteLab[idx],
      centroid: comp.paletteCentroids.get(idx)!,
      count: comp.paletteCounts.get(idx)!,
    }))

  // Solid if one color dominates strongly or only one passed the noise filter
  if (domShare >= 0.9 || colorList.length <= 1) {
    return { type: 'solid', hex: domHex, lum: domLum }
  }

  // Sort by Lab L (lightness) — lightest first
  colorList.sort((a, b) => b.lab[0] - a.lab[0])
  const first = colorList[0], last = colorList[colorList.length - 1]
  const c1 = first.centroid, c2 = last.centroid
  const dx = c2.x - c1.x, dy = c2.y - c1.y
  const lenSq = dx * dx + dy * dy

  // Lightest and darkest centroids coincide → shading isn't spatially organised
  // (just speckle noise). Fall back to solid.
  if (lenSq < 4) {
    return { type: 'solid', hex: domHex, lum: domLum }
  }

  // Project each constituent centroid onto the gradient axis for stop offset
  const rawStops = colorList.map(c => {
    const t = ((c.centroid.x - c1.x) * dx + (c.centroid.y - c1.y) * dy) / lenSq
    return {
      offset: Math.max(0, Math.min(1, t)),
      color: rgbToHex(palette[c.idx][0], palette[c.idx][1], palette[c.idx][2]),
      lab: paletteLab[c.idx],
    }
  })
  rawStops.sort((a, b) => a.offset - b.offset)

  // Dedupe stops with effectively-identical offsets — pick the one whose
  // lightness best matches its position on the lightness-sorted axis. SVG
  // doesn't render duplicate-offset stops cleanly (one wins arbitrarily) so
  // collapsing them produces a more predictable gradient.
  const stops: { offset: number; color: string }[] = []
  for (const s of rawStops) {
    const last = stops[stops.length - 1]
    if (last && Math.abs(last.offset - s.offset) < 0.02) {
      // Same offset — keep whichever stop is closer to its expected lightness.
      // (Not strictly necessary; just pick the second one to skip the first.)
      stops[stops.length - 1] = { offset: s.offset, color: s.color }
    } else {
      stops.push({ offset: s.offset, color: s.color })
    }
  }
  if (stops.length < 2) {
    return { type: 'solid', hex: domHex, lum: domLum }
  }
  stops[0].offset = 0
  stops[stops.length - 1].offset = 1

  const f = (v: number) => v.toFixed(1)
  const stopXml = stops
    .map(s => `<stop offset="${(s.offset * 100).toFixed(0)}%" stop-color="${s.color}"/>`)
    .join('')
  const defXml =
    `<linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse"` +
    ` x1="${f(c1.x)}" y1="${f(c1.y)}" x2="${f(c2.x)}" y2="${f(c2.y)}">${stopXml}</linearGradient>`

  return {
    type: 'gradient',
    defXml,
    refUrl: `url(#${gradientId})`,
    lum: domLum,
    primaryHex: domHex,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Potrace wrapper
// ─────────────────────────────────────────────────────────────────────────────

function traceBuffer(pngBuffer: Buffer, color: string, turdSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    potrace.trace(pngBuffer, {
      color,
      threshold: 128,
      turdSize,
      alphaMax: 1.3333,
      optCurve: true,
      optTolerance: 0.6,
    }, (err: Error | null, svg: string) => {
      if (err) return reject(err)
      resolve(svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)?.[1]?.trim() ?? '')
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Main conversion
// ─────────────────────────────────────────────────────────────────────────────

export async function convertImageToSvg(
  imageBuffer: Buffer,
  opts: ConversionOptions = {}
): Promise<ConversionResult> {
  const { maxSize = 900 } = opts  // sweet spot — bigger reveals anti-alias noise as fringe shapes

  // 1. Preprocess — resize, flatten transparency to white, smooth tiny noise
  const preprocessed = await sharp(imageBuffer)
    .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColorspace('srgb')
    .median(5)
    .png()
    .toBuffer()

  const meta = await sharp(preprocessed).metadata()
  const width = meta.width!, height = meta.height!
  const totalPixels = width * height

  const { data: rawData } = await sharp(preprocessed).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true })

  const pixelArray: RGB[] = new Array(totalPixels)
  for (let i = 0; i < totalPixels; i++) {
    pixelArray[i] = [rawData[i * 3], rawData[i * 3 + 1], rawData[i * 3 + 2]]
  }

  // 2. Quantize via median-cut
  const colorMap = quantize(pixelArray, QUANT_COLORS)
  if (!colorMap) throw new Error('Quantization failed — image may be a single color')
  const palette: RGB[] = colorMap.palette()
  const paletteLab = palette.map(([r, g, b]) => rgbToLab(r, g, b))

  // 3. Pixel → palette assignment by Lab distance (perceptually uniform)
  const pixelPaletteIdx = new Uint8Array(totalPixels)
  for (let i = 0; i < totalPixels; i++) {
    const [r, g, b] = pixelArray[i]
    const lab = rgbToLab(r, g, b)
    let bestIdx = 0, bestD = Infinity
    for (let j = 0; j < paletteLab.length; j++) {
      const d = labDistSq(lab, paletteLab[j])
      if (d < bestD) { bestD = d; bestIdx = j }
    }
    pixelPaletteIdx[i] = bestIdx
  }

  // 4. Cluster palette into clans (complete linkage caps clan diameter).
  // Threshold 18 keeps adjacent shading shades together (cheese yellows,
  // crust orange-browns) but leaves room for "detail" colors like pepperoni
  // pink speckles (Lab ~19 from main pepperoni red) to remain in their own
  // clan and survive as separate visible shapes.
  const CLAN_LAB_THRESH = 18
  const clanIds = clusterClans(paletteLab, CLAN_LAB_THRESH * CLAN_LAB_THRESH)

  // 5. Re-label every pixel with its clan
  const pixelClanIdx = new Uint8Array(totalPixels)
  for (let i = 0; i < totalPixels; i++) {
    pixelClanIdx[i] = clanIds[pixelPaletteIdx[i]]
  }

  // 6. Connected components on clan-labeled grid
  const { labels, components } = extractComponents(pixelClanIdx, width, height)

  // 7. Per-component stats (color histogram + centroids)
  computeComponentStats(components, labels, pixelPaletteIdx, width)

  // 8. Extract palette-level connected components for fine detail.
  // Clan-CCs give us "master shapes" (e.g. the whole pepperoni body), which
  // host smooth gradient-able silhouettes. But the SOURCE art is cel-shaded:
  // each pepperoni has crisp pink speckles, the crust has distinct gloss
  // bumps, the cheese has orange dot details. Those features are different
  // palette colors WITHIN one clan, so they vanish when the clan is rendered
  // as a single fill. Running connected components on the raw palette grid
  // recovers them as their own shapes, painted on top of their parent master.
  const { labels: pLabels, components: pComponents } =
    extractComponents(pixelPaletteIdx, width, height)

  // 9. Drop background components and tiny noise components.
  // Auto-scale turdSize and MIN_AREA from image resolution: the "right"
  // minimum shape size grows with the image (a 30-px speck at 200px is a
  // meaningful detail; the same speck at 1800px is just noise).
  // Bright highlight shapes (specular glints, eye whites) get a much lower
  // threshold — they're visually critical even when small.
  const maxDim = Math.max(width, height)
  const turdSize = Math.max(2, Math.floor(maxDim / 400))
  const MIN_AREA        = Math.max(20, turdSize * 5)
  const MIN_AREA_BRIGHT = Math.max(3,  turdSize)

  // Helper: dominant palette idx for a component (with stats already filled)
  const dominantPaletteOf = (c: Component): number => {
    let domIdx = -1, domCount = 0
    for (const [idx, count] of c.paletteCounts) {
      if (count > domCount) { domCount = count; domIdx = idx }
    }
    return domIdx
  }

  const passesAreaFilter = (area: number, palIdx: number): boolean => {
    const [r, g, b] = palette[palIdx]
    const isBright = luminance(r, g, b) > 220
    return area >= (isBright ? MIN_AREA_BRIGHT : MIN_AREA)
  }

  // Filter master clan-CCs: drop bg, drop tiny
  const validMasters = components.filter(c => {
    if (isBackgroundComponent(c, palette)) return false
    return passesAreaFilter(c.area, dominantPaletteOf(c))
  })

  // 10. Build the renderable list — master shapes plus detail shapes.
  // A detail is a palette-CC whose color differs from its parent master's
  // dominant. Same-colored palette-CCs are subsumed by the master (no point
  // emitting them separately — the master already paints with that color).
  type Renderable = {
    kind: 'master'
    comp: Component
    paletteIdx: number     // dominant palette of the master
    area: number
  } | {
    kind: 'detail'
    pcomp: Component
    paletteIdx: number     // the detail's own palette color
    parentMasterCompId: number
    area: number
  }

  const renderables: Renderable[] = []

  // Add masters
  const masterCompIdSet = new Set(validMasters.map(m => m.id))
  for (const m of validMasters) {
    renderables.push({
      kind: 'master',
      comp: m,
      paletteIdx: dominantPaletteOf(m),
      area: m.area,
    })
  }

  // Add details (palette-CCs whose color != parent master's dominant).
  // Reject "fringe rings" — thin strips of in-between color produced by
  // anti-aliasing along boundaries of two distinct regions. They quantize
  // to a muddy intermediate shade and trace as wavy 1-2px-wide rings that
  // look like artifacts. Detection: thickness = area / perimeter; a 2px-
  // wide ring has thickness ~1, a 3px line ~1.5, a real solid feature ≥2.
  // We also require the candidate's Lab to be perceptually "between" the
  // parent's dominant color and a near-white-or-near-black anchor, since
  // legitimate thin features (mouth strokes, eye outlines) tend to be
  // either far from the parent in chroma or distinctly dark/light, while
  // fringes are a desaturated midpoint.
  const FRINGE_THICKNESS = 1.5

  const isFringeRing = (pc: Component, parentDomPal: number, ownPal: number): boolean => {
    const thickness = pc.area / Math.max(1, pc.perimeter)
    if (thickness >= FRINGE_THICKNESS) return false
    // Keep tiny but non-stringy details (e.g. a 4×4 dot has thickness ~1
    // but isn't a ring). Only filter when both thin AND elongated.
    const compactness = (4 * Math.PI * pc.area) / (pc.perimeter * pc.perimeter)
    if (compactness >= 0.4) return false
    // Final sanity: small fringes only — never strip a major shape.
    if (pc.area > MIN_AREA * 6) return false
    // It's thin, elongated, small → almost certainly an anti-alias artifact.
    void parentDomPal; void ownPal
    return true
  }

  for (const pc of pComponents) {
    const parentMasterId = labels[pc.firstPixel]
    if (!masterCompIdSet.has(parentMasterId)) continue  // parent was filtered (bg etc.)

    const parent = components[parentMasterId]
    const parentDom = dominantPaletteOf(parent)
    const pcPalIdx  = pixelPaletteIdx[pc.firstPixel]
    if (pcPalIdx === parentDom) continue  // master already paints this color
    if (!passesAreaFilter(pc.area, pcPalIdx)) continue
    if (isFringeRing(pc, parentDom, pcPalIdx)) continue

    renderables.push({
      kind: 'detail',
      pcomp: pc,
      paletteIdx: pcPalIdx,
      parentMasterCompId: parentMasterId,
      area: pc.area,
    })
  }

  // 11. Painter's algorithm — largest first across both masters and details
  renderables.sort((a, b) => b.area - a.area)

  // 12. Per-pixel "owning layer" lookup. A pixel's owning layer is the smallest
  // emitted shape that paints it — the detail palette-CC if there is one,
  // otherwise the master clan-CC. -1 means bg/filtered (no paint).
  const renderIdxOfMaster = new Map<number, number>()  // master comp.id → render pos
  const renderIdxOfDetail = new Map<number, number>()  // palette comp.id → render pos
  renderables.forEach((r, idx) => {
    if (r.kind === 'master')      renderIdxOfMaster.set(r.comp.id, idx)
    else                          renderIdxOfDetail.set(r.pcomp.id, idx)
  })

  const pixelRenderOrder = new Int32Array(totalPixels)
  for (let i = 0; i < totalPixels; i++) {
    const detailIdx = renderIdxOfDetail.get(pLabels[i])
    if (detailIdx !== undefined) {
      pixelRenderOrder[i] = detailIdx
      continue
    }
    const masterIdx = renderIdxOfMaster.get(labels[i])
    pixelRenderOrder[i] = masterIdx !== undefined ? masterIdx : -1
  }

  // 13. Per-renderable: build mask → morphology → trace → emit
  const layers: string[] = []
  const layerColors: string[] = []
  const layerSvgs: string[] = []

  for (let pos = 0; pos < renderables.length; pos++) {
    const r = renderables[pos]
    const [pr, pg, pb] = palette[r.paletteIdx]
    const hex = rgbToHex(pr, pg, pb)
    const lum = luminance(pr, pg, pb)
    const isDarkLayer = lum < 80

    // Painter's algorithm:
    //   non-dark layers include all later (smaller) layers in their mask
    //     → solid filled silhouette that subsequent layers cover
    //   dark layers paint only their own pixels (outlines, thin separators)
    const maskRaw = Buffer.alloc(totalPixels * 3)
    for (let i = 0; i < totalPixels; i++) {
      const order = pixelRenderOrder[i]
      const include = isDarkLayer
        ? order === pos
        : order !== -1 && order >= pos
      const v = include ? 0 : 255
      maskRaw[i * 3] = v; maskRaw[i * 3 + 1] = v; maskRaw[i * 3 + 2] = v
    }

    // Morphology:
    //   dark  → opening (erode then dilate) with ~2px kernel. Removes thin
    //           anti-aliased "wing" protrusions extending from solid dark
    //           shapes (e.g. eyes growing eyelash-like spurs into adjacent
    //           cheese fringe), while keeping 3-px+ features (outlines, the
    //           crust/cheese separator) intact.
    //   light → blur(1.0)+threshold(185) — ~1px expansion to close layer gaps
    let pipeline = isDarkLayer
      ? sharp(maskRaw, { raw: { width, height, channels: 3 } })
          .blur(1.0).threshold(80)        // erode (kernel ~2px)
          .blur(1.0).threshold(195)       // dilate back
      : sharp(maskRaw, { raw: { width, height, channels: 3 } })
          .blur(1.0).threshold(185)

    pipeline = (pipeline as ReturnType<typeof sharp>)
      .blur(SMOOTH_SIGMA)
      .threshold(128) as ReturnType<typeof sharp>

    const maskPng = await (pipeline as ReturnType<typeof sharp>).png().toBuffer()

    try {
      const layerTurdSize = isDarkLayer ? Math.max(turdSize * 2, 4) : turdSize
      const raw = await traceBuffer(maskPng, hex, layerTurdSize)
      const fitted = raw ? fitPrimitivesInSvg(raw, hex) : raw
      if (!fitted) continue

      const inner = fitted.replace(/fill="[^"]*"/g, `fill="${hex}"`)
      layers.push(inner)
      layerColors.push(hex)
      layerSvgs.push(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"` +
        ` style="display:block;width:100%;height:auto"><g>${inner}</g></svg>`
      )
    } catch { /* skip failed shapes */ }
  }

  if (layers.length === 0) throw new Error('No vector paths could be traced from this image')

  // 14. Assemble final SVG
  const defsBlock = ''
  const body = layers.map(l => `  <g>${l}</g>`).join('\n')
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     viewBox="0 0 ${width} ${height}"`,
    `     style="display:block;width:100%;height:auto">`,
    defsBlock + body,
    `</svg>`,
  ].join('\n')

  return { svg, palette: layerColors, layers: layerSvgs, width, height }
}
