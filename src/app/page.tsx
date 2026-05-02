'use client'

import { useState, useCallback, useRef } from 'react'

type Stage = 'idle' | 'ready' | 'converting' | 'done' | 'error'

function UploadIcon() {
  return (
    <svg className="w-12 h-12 text-purple-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16v-8m0 0-3 3m3-3 3 3M4.5 19.5h15a2.25 2.25 0 0 0 2.25-2.25V8.25a2.25 2.25 0 0 0-2.25-2.25H4.5A2.25 2.25 0 0 0 2.25 8.25v9a2.25 2.25 0 0 0 2.25 2.25Z" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin h-5 w-5 text-purple-400" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  )
}

export default function Home() {
  const [stage, setStage] = useState<Stage>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [svgResult, setSvgResult] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [colors, setColors] = useState(16)
  const [turdSize, setTurdSize] = useState(2)
  const [smoothing, setSmoothing] = useState(1)
  const inputRef = useRef<HTMLInputElement>(null)

  const acceptFile = useCallback((f: File) => {
    setFile(f)
    setStage('ready')
    setSvgResult(null)
    setErrorMsg(null)
    const url = URL.createObjectURL(f)
    setPreviewUrl(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) acceptFile(f)
  }, [acceptFile])

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) acceptFile(f)
  }, [acceptFile])

  const convert = useCallback(async () => {
    if (!file) return
    setStage('converting')
    setSvgResult(null)
    setErrorMsg(null)

    try {
      const form = new FormData()
      form.append('image', file)
      form.append('colors', String(colors))
      form.append('turdSize', String(turdSize))
      form.append('smoothing', String(smoothing))

      const res = await fetch('/api/convert', { method: 'POST', body: form })

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Conversion failed' }))
        throw new Error(data.error ?? 'Conversion failed')
      }

      const svg = await res.text()
      setSvgResult(svg)
      setStage('done')
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong')
      setStage('error')
    }
  }, [file, colors, turdSize])

  const downloadSvg = useCallback(() => {
    if (!svgResult) return
    const blob = new Blob([svgResult], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = (file?.name.replace(/\.[^.]+$/, '') ?? 'image') + '.svg'
    a.click()
    URL.revokeObjectURL(url)
  }, [svgResult, file])

  const reset = useCallback(() => {
    setStage('idle')
    setFile(null)
    setSvgResult(null)
    setErrorMsg(null)
    setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  const isConverting = stage === 'converting'
  const hasImage = stage !== 'idle'

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-12">
      {/* Header */}
      <div className="text-center mb-10">
        <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-purple-400 via-violet-300 to-indigo-400 bg-clip-text text-transparent">
          img → svg
        </h1>
        <p className="mt-2 text-sm text-gray-400 max-w-md">
          Color-accurate vector conversion. Each hue becomes its own traced layer, stacked in depth order.
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
        className="hidden"
        onChange={onFileChange}
      />

      <div className="w-full max-w-6xl flex flex-col gap-4">

        {/* ── IDLE: big upload zone ─────────────────────────────────────────── */}
        {!hasImage && (
          <div
            className={`rounded-2xl border-2 border-dashed transition-all duration-200 flex flex-col items-center justify-center p-20 cursor-pointer
              ${isDragging ? 'border-purple-400 bg-purple-900/20' : 'border-[#2a2a38] bg-[#1a1a24] hover:border-purple-600'}`}
            onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
          >
            <UploadIcon />
            <p className="font-medium text-gray-200 text-lg">Drop an image here</p>
            <p className="text-xs text-gray-500 mt-2">PNG, JPG, WEBP, GIF, BMP · up to 20 MB</p>
          </div>
        )}

        {/* ── WITH IMAGE: two preview panels + toolbar ─────────────────────── */}
        {hasImage && (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-3 flex-wrap">
              {/* File chip */}
              <button
                onClick={() => inputRef.current?.click()}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#1a1a24] border border-[#2a2a38] text-xs text-gray-400 hover:text-white hover:border-purple-600 transition-all"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                </svg>
                {file?.name ?? 'image'}
              </button>

              {/* Colors */}
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#1a1a24] border border-[#2a2a38]">
                <span className="text-xs text-gray-400">Colors</span>
                <span className="text-xs text-purple-400 font-mono w-7 text-right">{colors}</span>
                <input
                  type="range" min={4} max={100} step={1} value={colors}
                  onChange={e => setColors(Number(e.target.value))}
                  className="w-24 accent-purple-500"
                />
              </div>

              {/* Smoothing */}
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#1a1a24] border border-[#2a2a38]">
                <span className="text-xs text-gray-400">Smooth</span>
                <span className="text-xs text-purple-400 font-mono w-5 text-right">{smoothing}</span>
                <input
                  type="range" min={0} max={5} step={0.5} value={smoothing}
                  onChange={e => setSmoothing(Number(e.target.value))}
                  className="w-20 accent-purple-500"
                />
              </div>

              {/* Noise removal */}
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#1a1a24] border border-[#2a2a38]">
                <span className="text-xs text-gray-400">Noise</span>
                <span className="text-xs text-purple-400 font-mono w-3 text-right">{turdSize}</span>
                <input
                  type="range" min={0} max={10} step={1} value={turdSize}
                  onChange={e => setTurdSize(Number(e.target.value))}
                  className="w-20 accent-purple-500"
                />
              </div>

              {/* Spacer */}
              <div className="flex-1" />

              {/* Actions */}
              {svgResult && (
                <button
                  onClick={downloadSvg}
                  className="px-4 py-1.5 text-xs rounded-lg bg-[#1a1a24] border border-[#2a2a38] text-gray-300 hover:text-white hover:border-purple-600 transition-all font-medium"
                >
                  Download SVG
                </button>
              )}
              <button
                onClick={convert}
                disabled={isConverting}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-semibold transition-all
                  ${!isConverting
                    ? 'bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-900/40 active:scale-95'
                    : 'bg-[#22223a] text-gray-500 cursor-not-allowed'}`}
              >
                {isConverting && <Spinner />}
                {isConverting ? 'Converting…' : 'Convert'}
              </button>
              <button
                onClick={reset}
                className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:text-white hover:bg-[#22223a] transition-all"
              >
                Reset
              </button>
            </div>

            {/* Error */}
            {stage === 'error' && errorMsg && (
              <div className="rounded-xl bg-red-950/60 border border-red-800 px-5 py-3 text-red-300 text-sm">
                {errorMsg}
              </div>
            )}

            {/* Two panels */}
            <div className="grid grid-cols-2 gap-4">
              {/* Original */}
              <div className="rounded-2xl bg-[#1a1a24] border border-[#2a2a38] overflow-hidden flex flex-col">
                <div className="px-4 py-2.5 border-b border-[#2a2a38] flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Original</span>
                  <button
                    onClick={() => inputRef.current?.click()}
                    className="text-xs text-gray-600 hover:text-purple-400 transition-colors"
                  >
                    change
                  </button>
                </div>
                <div
                  className="checker flex-1 flex items-center justify-center p-4"
                  style={{ minHeight: '400px' }}
                  onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={onDrop}
                >
                  {previewUrl && (
                    <img
                      src={previewUrl}
                      alt="Original"
                      className="max-w-full max-h-[480px] object-contain"
                    />
                  )}
                </div>
              </div>

              {/* SVG */}
              <div className="rounded-2xl bg-[#1a1a24] border border-[#2a2a38] overflow-hidden flex flex-col">
                <div className="px-4 py-2.5 border-b border-[#2a2a38] flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-widest">SVG</span>
                  {svgResult && (
                    <span className="text-xs text-gray-600">
                      {(new Blob([svgResult]).size / 1024).toFixed(0)} KB
                    </span>
                  )}
                </div>
                <div
                  className="checker flex-1 flex items-center justify-center p-4"
                  style={{ minHeight: '400px' }}
                >
                  {isConverting ? (
                    <div className="flex flex-col items-center gap-3 text-gray-500">
                      <Spinner />
                      <p className="text-xs">Tracing layers…</p>
                    </div>
                  ) : svgResult ? (
                    <div
                      className="w-full max-h-[480px] overflow-hidden"
                      style={{ lineHeight: 0 }}
                      dangerouslySetInnerHTML={{ __html: svgResult }}
                    />
                  ) : (
                    <p className="text-xs text-gray-600">Hit Convert to trace</p>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <footer className="mt-16 text-xs text-gray-600">
        Vectors powered by Potrace · Color quantization via median-cut
      </footer>
    </main>
  )
}
