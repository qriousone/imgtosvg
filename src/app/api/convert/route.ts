import { NextRequest, NextResponse } from 'next/server'
import { convertImageToSvg } from '@/lib/converter'

export const maxDuration = 60

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'])
const MAX_BYTES = 20 * 1024 * 1024

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('image')
    const colors = parseInt((form.get('colors') as string) || '16', 10)
    const turdSize = parseInt((form.get('turdSize') as string) || '2', 10)
    const smoothing = parseFloat((form.get('smoothing') as string) || '1')

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No image uploaded' }, { status: 400 })
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
    }

    const arrayBuffer = await file.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: 'File too large (max 20 MB)' }, { status: 413 })
    }

    const result = await convertImageToSvg(Buffer.from(arrayBuffer), { colors, turdSize, smoothing })

    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Conversion failed'
    console.error('[convert]', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
