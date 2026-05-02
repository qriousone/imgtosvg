'use client'

import { useState, useCallback, useRef } from 'react'

type Stage = 'idle' | 'ready' | 'converting' | 'done' | 'error'

const COLOR_OPTIONS = [4, 8, 12, 16, 24, 32]

function UploadIcon() {
  return (
    <svg className="w-12 h-12 text-purple-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16v-8m0 0-3 3m3-3 3 3M4.5 19.5h15a2.25 2.25 0 0 0 2.25-2.25V8.25a2.25 2.25 0 0 0-2.25-2.25H4.5A2.25 2.25 0 0 0 2.25 8.25v9a2.25 2.25 0 0 0 2.25 2.25Z" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin h-6 w-6 text-purple-400" viewBox="0 0 24 24" fill="none">
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
  const [activeTab, setActiveTab] = useState<'original' | 'svg'>('original')
  const inputRef = useRef<HTMLInputElement>(null)

  const acceptFile = useCallback((f: File) => {
    setFile(f)
    setStage('ready')
    setSvgResult(null)
    setErrorMsg(null)
    setActiveTab('original')
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

      const res = await fetch('/api/convert', { method: 'POST', body: form })

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Conversion failed' }))
        throw new Error(data.error ?? 'Conversion failed')
      }

      const svg = await res.text()
      setSvgResult(svg)
      setStage('done')
      setActiveTab('svg')
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

      <div className="w-full max-w-5xl flex flex-col gap-6">
        {/* Top row: upload + settings */}
        <div className="flex flex-col lg:flex-row gap-6">

          {/* Upload zone */}
          <div
            className={`flex-1 rounded-2xl border-2 border-dashed transition-all duration-200 flex flex-col items-center justify-center p-10 cursor-pointer
              ${isDragging ? 'border-purple-400 bg-purple-900/20' : 'border-[#2a2a38] bg-[#1a1a24] hover:border-purple-600'}
              ${stage !== 'idle' && stage !== 'ready' ? 'opacity-50 pointer-events-none' : ''}`}
            onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
              className="hidden"
              onChange={onFileChange}
            />
            <UploadIcon />
            {file ? (
              <div className="text-center">
                <p className="font-medium text-white">{file.name}</p>
                <p className="text-xs text-gray-400 mt-1">{(file.size / 1024).toFixed(0)} KB · click to change</p>
              </div>
            ) : (
              <div className="text-center">
                <p className="font-medium text-gray-200">Drop image here</p>
                <p className="text-xs text-gray-500 mt-1">PNG, JPG, WEBP, GIF, BMP · up to 20 MB</p>
              </div>
            )}
          </div>

          {/* Settings panel */}
          <div className="lg:w-64 rounded-2xl bg-[#1a1a24] border border-[#2a2a38] p-6 flex flex-col gap-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Settings</p>

            <div>
              <label className="text-sm text-gray-300 mb-2 block">
                Colors
                <span className="ml-2 text-purple-400 font-mono">{colors}</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {COLOR_OPTIONS.map(n => (
                  <button
                    key={n}
                    onClick={() => setColors(n)}
                    className={`px-3 py-1 rounded-lg text-sm font-mono transition-all
                      ${colors === n
                        ? 'bg-purple-600 text-white'
                        : 'bg-[#12121a] text-gray-400 hover:bg-[#22223a]'}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                More colors = more detail, slower conversion.
              </p>
            </div>

            <div>
              <label className="text-sm text-gray-300 mb-2 block">
                Noise removal
                <span className="ml-2 text-purple-400 font-mono">{turdSize}</span>
              </label>
              <input
                type="range"
                min={0} max={10} step={1}
                value={turdSize}
                onChange={e => setTurdSize(Number(e.target.value))}
                className="w-full accent-purple-500"
              />
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>none</span><span>aggressive</span>
              </div>
            </div>

            <div className="mt-auto flex flex-col gap-2">
              <button
                onClick={convert}
                disabled={!file || isConverting}
                className={`w-full py-3 rounded-xl font-semibold text-sm transition-all
                  ${file && !isConverting
                    ? 'bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-900/40 active:scale-95'
                    : 'bg-[#22223a] text-gray-500 cursor-not-allowed'}`}
              >
                {isConverting ? (
                  <span className="flex items-center justify-center gap-2"><Spinner /> Converting…</span>
                ) : 'Convert to SVG'}
              </button>

              {(stage === 'done' || stage === 'error' || stage === 'ready') && (
                <button
                  onClick={reset}
                  className="w-full py-2 rounded-xl text-sm text-gray-400 hover:text-white hover:bg-[#22223a] transition-all"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Error banner */}
        {stage === 'error' && errorMsg && (
          <div className="rounded-xl bg-red-950/60 border border-red-800 px-5 py-4 text-red-300 text-sm">
            {errorMsg}
          </div>
        )}

        {/* Preview area */}
        {(previewUrl || svgResult) && (
          <div className="rounded-2xl bg-[#1a1a24] border border-[#2a2a38] overflow-hidden">
            {/* Tabs */}
            <div className="flex border-b border-[#2a2a38]">
              <button
                className={`px-6 py-3 text-sm font-medium transition-all border-b-2 -mb-px
                  ${activeTab === 'original'
                    ? 'border-purple-500 text-purple-300'
                    : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                onClick={() => setActiveTab('original')}
              >
                Original
              </button>
              <button
                className={`px-6 py-3 text-sm font-medium transition-all border-b-2 -mb-px
                  ${activeTab === 'svg'
                    ? 'border-purple-500 text-purple-300'
                    : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                onClick={() => setActiveTab('svg')}
                disabled={!svgResult}
              >
                SVG {svgResult ? '✓' : ''}
              </button>

              {svgResult && (
                <button
                  onClick={downloadSvg}
                  className="ml-auto mr-4 my-2 px-4 py-1.5 text-xs rounded-lg bg-purple-700 hover:bg-purple-600 text-white font-medium transition-all active:scale-95"
                >
                  Download SVG
                </button>
              )}
            </div>

            {/* Content */}
            <div className="checker min-h-72 flex items-center justify-center p-6 overflow-hidden" style={{ maxHeight: '560px' }}>
              {activeTab === 'original' && previewUrl && (
                <img
                  src={previewUrl}
                  alt="Original"
                  className="max-w-full max-h-[520px] object-contain rounded shadow-2xl"
                />
              )}

              {activeTab === 'svg' && (
                isConverting ? (
                  <div className="flex flex-col items-center gap-3 text-gray-400">
                    <Spinner />
                    <p className="text-sm">Tracing layers…</p>
                  </div>
                ) : svgResult ? (
                  <div
                    className="w-full"
                    style={{ maxHeight: '520px', overflow: 'hidden', lineHeight: 0 }}
                    dangerouslySetInnerHTML={{ __html: svgResult }}
                  />
                ) : null
              )}
            </div>
          </div>
        )}

        {/* Side-by-side when both available */}
        {svgResult && previewUrl && (
          <div className="rounded-2xl bg-[#1a1a24] border border-[#2a2a38] p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">Side by side</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="checker rounded-xl overflow-hidden flex items-center justify-center p-4 min-h-48">
                <img src={previewUrl} alt="Original" className="max-w-full max-h-64 object-contain" />
              </div>
              <div className="checker rounded-xl overflow-hidden p-4 min-h-48">
                <div
                  className="w-full"
                  dangerouslySetInnerHTML={{ __html: svgResult }}
                  style={{ lineHeight: 0 }}
                />
              </div>
            </div>
            <div className="flex justify-center gap-8 mt-3 text-xs text-gray-500">
              <span>Original</span>
              <span>SVG</span>
            </div>
          </div>
        )}
      </div>

      <footer className="mt-16 text-xs text-gray-600">
        Vectors powered by Potrace · Color quantization via median-cut
      </footer>
    </main>
  )
}
