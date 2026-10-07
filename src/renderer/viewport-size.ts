// Sizing the engine's viewport to the page: the engine renders at the viewport container's size in device pixels,
// and the canvas shows each frame 1:1 (CSS size = pixels / devicePixelRatio). Pure functions, unit tested.

/** The engine refuses sizes outside 1..MaxViewportDimension (EditorServer::MaxViewportDimension) */
export const MaxViewportDimension = 4096

export interface PixelSize {
  width: number
  height: number
}

/**
 * The render size for a container of cssWidth x cssHeight CSS pixels at devicePixelRatio: rounded to whole device
 * pixels, and scaled down (keeping the aspect ratio) when a side would exceed max. Null when the container has no
 * area (hidden, or collapsed), since the engine can't render a 0-pixel viewport.
 */
export function viewportPixelSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  max: number = MaxViewportDimension
): PixelSize | null {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const width = cssWidth * ratio
  const height = cssHeight * ratio
  if (!(width > 0 && height > 0)) return null

  const scale = Math.min(1, max / width, max / height)
  return {
    width: clamp(Math.round(width * scale), 1, max),
    height: clamp(Math.round(height * scale), 1, max),
  }
}

/** The CSS size that shows a frame of the given pixels 1:1 on the screen */
export function cssSizeForPixels(pixels: PixelSize, devicePixelRatio: number): PixelSize {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  return { width: pixels.width / ratio, height: pixels.height / ratio }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
