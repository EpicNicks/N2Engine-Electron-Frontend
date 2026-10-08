// Shows the engine's frames on the viewport's canvas: a RenderFrame loop while connected, and the engine's viewport
// kept at the container's size in device pixels. The canvas shows each frame 1:1: its drawing buffer is the frame's
// size and its CSS size is that divided by devicePixelRatio. It is positioned absolutely, so its size never feeds
// back into the layout; while a resize is pending, a stale frame is shown unscaled (cropped or bordered) rather than
// stretched. Frames arrive as RGBA, top row first (engine #69), and are drawn as they are.
import type { EngineApi } from "../shared/api"
import { PixelSize, cssSizeForPixels, viewportPixelSize } from "./viewport-size"

/** After the container stops changing size for this long, the new size is sent (on the next animation frame) */
const ViewportSettleMilliseconds = 100

export class ViewportRenderer {
  private readonly context: CanvasRenderingContext2D
  private running = false
  private frameRequest: number | null = null
  // Bumped by every start and stop: a loop whose generation is stale ends at its next check, including one that
  // was awaiting a frame when it was stopped, so a quick stop and start never leaves two loops running
  private generation = 0
  private sentSize: PixelSize | null = null
  private settleTimer: number | null = null
  private readonly resizeObserver: ResizeObserver
  private disposed = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLElement,
    private readonly engine: Pick<EngineApi, "isConnected" | "renderFrame" | "setViewportSize">,
    private readonly onError: (e: unknown) => void
  ) {
    this.context = canvas.getContext("2d")!
    this.resizeObserver = new ResizeObserver(() => {
      this.showCanvasAtDevicePixels()
      this.scheduleSync()
    })
    this.resizeObserver.observe(container)
    this.showCanvasAtDevicePixels()
    this.watchDevicePixelRatio()
  }

  /** Starts rendering (once connected): sends the size first, so the first frame is already the right size */
  start(): void {
    if (this.running || this.disposed) return
    this.syncSize(true)
    this.running = true
    const generation = ++this.generation

    const render = async (): Promise<void> => {
      this.frameRequest = null
      if (generation !== this.generation) return
      if (!this.engine.isConnected()) {
        this.stop()
        return
      }
      try {
        const frame = await this.engine.renderFrame()
        if (generation !== this.generation) return
        if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
          this.canvas.width = frame.width
          this.canvas.height = frame.height
          this.showCanvasAtDevicePixels()
        }
        // A view of the received pixels, not a copy (they arrive in a plain ArrayBuffer, never a shared one)
        const { buffer, byteOffset, byteLength } = frame.pixels
        const pixels = new Uint8ClampedArray(buffer as ArrayBuffer, byteOffset, byteLength)
        this.context.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0)
      } catch (e) {
        if (generation === this.generation) {
          this.stop()
          this.onError(e)
        }
        return
      }
      this.frameRequest = requestAnimationFrame(render)
    }
    render()
  }

  stop(): void {
    this.running = false
    this.generation++
    this.sentSize = null
    if (this.frameRequest !== null) {
      cancelAnimationFrame(this.frameRequest)
      this.frameRequest = null
    }
  }

  dispose(): void {
    this.stop()
    this.disposed = true
    this.resizeObserver.disconnect()
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer)
  }

  /** Sizes and centres the canvas so one frame pixel is one device pixel */
  private showCanvasAtDevicePixels(): void {
    const ratio = window.devicePixelRatio || 1
    const css = cssSizeForPixels({ width: this.canvas.width, height: this.canvas.height }, ratio)
    const container = this.container.getBoundingClientRect()
    this.canvas.style.width = `${css.width}px`
    this.canvas.style.height = `${css.height}px`
    // Offsets rounded to whole device pixels, so the frame isn't resampled by a half-pixel shift
    this.canvas.style.left = `${Math.round(((container.width - css.width) / 2) * ratio) / ratio}px`
    this.canvas.style.top = `${Math.round(((container.height - css.height) / 2) * ratio) / ratio}px`
  }

  /** Sends the container's device-pixel size to the engine, if it changed (or always, when forced) */
  private syncSize(force: boolean = false): void {
    if (!this.engine.isConnected()) {
      this.sentSize = null
      return
    }
    const rect = this.container.getBoundingClientRect()
    const size = viewportPixelSize(rect.width, rect.height, window.devicePixelRatio)
    if (!size) return // hidden
    if (!force && this.sentSize?.width === size.width && this.sentSize?.height === size.height) return

    this.sentSize = size
    this.engine.setViewportSize(size.width, size.height).catch((e) => {
      console.error("Failed to set viewport size:", e)
      this.sentSize = null
    })
  }

  private scheduleSync(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null
      requestAnimationFrame(() => this.syncSize())
    }, ViewportSettleMilliseconds)
  }

  /** devicePixelRatio changes when the window moves to a monitor with another scale, or the page zoom changes */
  private watchDevicePixelRatio(): void {
    if (this.disposed) return
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        this.showCanvasAtDevicePixels()
        this.scheduleSync()
        this.watchDevicePixelRatio()
      },
      { once: true }
    )
  }
}
