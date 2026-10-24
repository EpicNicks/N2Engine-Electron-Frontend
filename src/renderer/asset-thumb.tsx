// A texture's thumbnail or an audio clip's waveform (protocol 1.17.0: GetAssetPreview, through the cache in
// asset-previews.ts). It shows nothing while the preview is on its way, when the host can't make one, or for a type
// that has none; the asset's row is the same either way.
import { useEffect, useRef, useState } from "preact/hooks"
import type { AssetPreview, AudioPreview, TexturePreview } from "../protocol/editor-tooling"
import { PreviewAsset, previewKindOf } from "./asset-previews"
import { useApp } from "./ui"

/** Size asked of the host for a row's thumbnail, and for the selected asset's larger preview */
export const RowPreviewSize = 64
export const DetailPreviewSize = 256

/** Draws a texture preview's RGBA pixels into a 2D context of a canvas of its size; false when the context can't */
export function drawTexture(ctx: CanvasRenderingContext2D | null, preview: TexturePreview): boolean {
  if (!ctx) return false
  const image = ctx.createImageData(preview.width, preview.height)
  image.data.set(preview.pixels)
  ctx.putImageData(image, 0, 0)
  return true
}

/** The SVG path of a waveform: one vertical line per peak bin, from its minimum to its maximum, in a 2-unit-high box */
export function waveformPath(peaks: ReadonlyArray<{ min: number; max: number }>): string {
  const clamp = (v: number): number => Math.max(-1, Math.min(1, v))
  const parts: string[] = []
  peaks.forEach((peak, i) => {
    const top = 1 - clamp(peak.max)
    // A silent bin still gets a hairline, so the clip's length shows
    const bottom = Math.max(1 - clamp(peak.min), top + 0.04)
    parts.push(`M${i + 0.5} ${top.toFixed(3)}V${bottom.toFixed(3)}`)
  })
  return parts.join("")
}

function TextureCanvas({ preview, label }: { preview: TexturePreview; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    drawTexture(canvas.current?.getContext("2d") ?? null, preview)
  }, [preview])
  return (
    <canvas
      ref={canvas}
      class="asset-thumb"
      data-preview="texture"
      width={preview.width}
      height={preview.height}
      role="img"
      aria-label={label}
    />
  )
}

function Waveform({ preview, label }: { preview: AudioPreview; label: string }) {
  const bins = Math.max(1, preview.peaks.length)
  return (
    <svg
      class="asset-thumb asset-wave"
      data-preview="audio"
      viewBox={`0 0 ${bins} 2`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path d={waveformPath(preview.peaks)} vector-effect="non-scaling-stroke" />
    </svg>
  )
}

export function PreviewView({ preview, name }: { preview: AssetPreview; name: string }) {
  if (preview.kind === "texture") return <TextureCanvas preview={preview} label={`Preview of ${name}`} />
  return <Waveform preview={preview} label={`Waveform of ${name}`} />
}

/** The preview of one asset at the size asked; nothing until (and unless) the host has one */
export function AssetThumb({ asset, size, name }: { asset: PreviewAsset; size: number; name: string }) {
  const { assets } = useApp()
  const cache = assets.previews
  // Dropped entries (a change event, a new connection) ask again
  const version = cache.version.value
  const kind = previewKindOf(asset.type)
  const [preview, setPreview] = useState<AssetPreview | null>(null)
  useEffect(() => {
    if (kind === null || !cache.enabled) {
      setPreview(null)
      return
    }
    const cached = cache.peek(asset, size)
    if (cached) {
      setPreview(cached)
      return
    }
    // The old picture is of the old file
    setPreview(null)
    let live = true
    cache.request(asset, size).then(
      (answer) => {
        if (live) setPreview(answer)
      },
      () => {
        if (live) setPreview(null)
      }
    )
    return () => {
      live = false
    }
  }, [cache, kind, asset.uuid, asset.path, asset.type, asset.modified, asset.size, size, version])
  return preview ? <PreviewView preview={preview} name={name} /> : null
}
