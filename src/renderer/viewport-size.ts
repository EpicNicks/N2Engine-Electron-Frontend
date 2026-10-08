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

/**
 * A pointer position as a pixel of the engine's frame (top-left origin, y down): the position inside the canvas's
 * on-screen rectangle (CSS pixels), scaled to the frame's pixels (so the device pixel ratio is whatever the frame was
 * sized with). Fractions are kept: the host takes float pixels.
 */
export function framePixelOf(
  client: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  frame: PixelSize
): { x: number; y: number } {
  return {
    x: ((client.x - rect.left) * frame.width) / Math.max(1, rect.width),
    y: ((client.y - rect.top) * frame.height) / Math.max(1, rect.height),
  }
}

/** Whether a frame pixel is inside the viewport (0 up to, not including, its size): outside is a miss */
export const insideFrame = (pixel: { x: number; y: number }, frame: PixelSize): boolean =>
  pixel.x >= 0 && pixel.y >= 0 && pixel.x < frame.width && pixel.y < frame.height
