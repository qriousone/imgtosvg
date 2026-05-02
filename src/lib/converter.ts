import sharp from 'sharp'
import potrace from 'potrace'
import quantize from 'quantize'

export interface ConversionOptions {
  colors?: number    // palette size: 4–32
  turdSize?: number  // min area to keep (noise removal)
  maxSize?: number   // max dimension before resize
}

type RGB = [number, number, number]

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}

function luminance(r: number, g: number, b: number): number {
  // Perceptual luminance — determines layer draw order
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function colorKey(c: RGB): string {
  return `${c[0]},${c[1]},${c[2]}`
}

function traceBuffer(pngBuffer: Buffer, color: string, turdSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    potrace.trace(pngBuffer, { color, threshold: 128, turdSize }, (err: Error | null, svg: string) => {
      if (err) return reject(err)
      // Extract everything inside the outer <svg> so we keep the transform wrapper if present
      const inner = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)?.[1]?.trim() ?? ''
      resolve(inner)
    })
  })
}

export async function convertImageToSvg(
  imageBuffer: Buffer,
  opts: ConversionOptions = {}
): Promise<string> {
  const { colors = 16, turdSize = 2, maxSize = 900 } = opts

  // ── 1. Preprocess ────────────────────────────────────────────────────────────
  // Resize so potrace stays fast; flatten alpha onto white so colors are clean.
  const preprocessed = await sharp(imageBuffer)
    .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColorspace('srgb')
    .png()
    .toBuffer()

  const { width, height } = await sharp(preprocessed).metadata()
  if (!width || !height) throw new Error('Could not read image dimensions')

  // ── 2. Read raw RGB pixels ───────────────────────────────────────────────────
  const { data: rawData } = await sharp(preprocessed)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const totalPixels = width * height
  const pixelArray: RGB[] = new Array(totalPixels)
  for (let i = 0; i < totalPixels; i++) {
    pixelArray[i] = [rawData[i * 3], rawData[i * 3 + 1], rawData[i * 3 + 2]]
  }

  // ── 3. Quantize colors (median-cut) ──────────────────────────────────────────
  const colorCount = Math.max(2, Math.min(colors, 32))
  const colorMap = quantize(pixelArray, colorCount)
  if (!colorMap) throw new Error('Quantization failed — image may be too simple')

  const palette: RGB[] = colorMap.palette()

  // Map each pixel to its palette index
  const keyToIdx = new Map<string, number>(palette.map((c, i) => [colorKey(c), i]))
  const pixelPaletteIdx = new Uint8Array(totalPixels)
  for (let i = 0; i < totalPixels; i++) {
    const mapped = colorMap.map(pixelArray[i]) as RGB
    pixelPaletteIdx[i] = keyToIdx.get(colorKey(mapped)) ?? 0
  }

  // ── 4. Sort palette darkest → lightest ───────────────────────────────────────
  // Darker layers go underneath; lighter ones overlay them, matching natural depth.
  const sortedPalette = palette
    .map((c, idx) => ({ c, idx, lum: luminance(c[0], c[1], c[2]) }))
    .sort((a, b) => a.lum - b.lum)

  // ── 5. Per-color mask → trace ─────────────────────────────────────────────────
  const layers: string[] = []

  for (const { c, idx } of sortedPalette) {
    // Build a black-on-white binary mask for this palette entry.
    // Potrace traces the dark (black) regions on a white background.
    const maskRaw = Buffer.alloc(totalPixels * 3)
    for (let i = 0; i < totalPixels; i++) {
      const v = pixelPaletteIdx[i] === idx ? 0 : 255  // 0 = this color → black
      maskRaw[i * 3] = v
      maskRaw[i * 3 + 1] = v
      maskRaw[i * 3 + 2] = v
    }

    const maskPng = await sharp(maskRaw, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer()

    try {
      const hex = rgbToHex(c[0], c[1], c[2])
      const inner = await traceBuffer(maskPng, hex, turdSize)
      if (inner) layers.push(inner)
    } catch {
      // Skip layers that fail silently
    }
  }

  if (layers.length === 0) throw new Error('No vector paths could be traced from this image')

  // ── 6. Assemble final SVG ────────────────────────────────────────────────────
  // Wrap each potrace output in a <g> so their individual transforms are preserved.
  const body = layers.map(l => `  <g>${l}</g>`).join('\n')

  // No fixed width/height — let CSS control sizing via the viewBox aspect ratio.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     viewBox="0 0 ${width} ${height}"`,
    `     style="display:block;width:100%;height:auto">`,
    body,
    `</svg>`,
  ].join('\n')
}
