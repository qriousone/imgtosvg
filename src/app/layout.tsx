import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'img → svg',
  description: 'Convert any raster image to a clean, layered SVG using color-accurate vector tracing.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
