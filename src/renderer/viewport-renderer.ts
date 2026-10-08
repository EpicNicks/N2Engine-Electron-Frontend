// Shows the engine's frames on the viewport's canvas, on demand: a RenderFrameIfChanged (protocol 1.7.0) when the view
// may have changed (FrameScheduler, viewport-frames.ts; nothing is polled at a fixed rate), and the engine's viewport
// kept at the container's size in device pixels. The canvas shows each frame 1:1: its drawing buffer is the frame's
// size and its CSS size is that divided by devicePixelRatio. It is positioned absolutely, so its size never feeds
// back into the layout; while a resize is pending, a stale frame is shown unscaled (cropped or bordered) rather than
// stretched. Frames arrive as RGBA, top row first (engine #69), and are drawn as they are.
import type { EngineApi } from "../shared/api"
import { FrameScheduler } from "./viewport-frames"
import { PixelSize, cssSizeForPixels, viewportPixelSize } from "./viewport-size"

/** After the container stops changing size for this long, the new size is sent (on the next animation frame) */
const ViewportSettleMilliseconds = 100

export interface ViewportHooks {
  /** A frame was presented: its size is the one the picture (and so the gizmo's maths) has */
  onFrame?(size: PixelSize): void
  /** The canvas was moved, resized or given a new frame size: an overlay on top of it follows */
  onLayout?(): void
  /**
   * The size the host's viewport has been told (null: none, or the request failed): the host renders and picks at it
   * from then on, while the picture on screen may still be a frame of the size before (until the next frame arrives)
   */
  onHostSize?(size: PixelSize | null): void
}

export class ViewportRenderer {
  private readonly context: CanvasRenderingContext2D
  private readonly scheduler: FrameScheduler
  private sentSize: PixelSize | null = null
  private settleTimer: number | null = null
  private readonly resizeObserver: ResizeObserver
  private disposed = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLElement,
    private readonly engine: Pick<EngineApi, "isConnected" | "renderFrameIfChanged" | "setViewportSize">,
    private readonly onError: (e: unknown) => void,
    private readonly hooks: ViewportHooks = {}
  ) {
    this.context = canvas.getContext("2d")!
    this.scheduler = new FrameScheduler({
      request: (since) => this.engine.renderFrameIfChanged(since),
      present: (frame) => {
        if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
          this.canvas.width = frame.width
          this.canvas.height = frame.height
          this.showCanvasAtDevicePixels()
        }
        // A view of the received pixels, not a copy (they arrive in a plain ArrayBuffer, never a shared one)
        const { buffer, byteOffset, byteLength } = frame.pixels
        const pixels = new Uint8ClampedArray(buffer as ArrayBuffer, byteOffset, byteLength)
        this.context.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0)
        this.hooks.onFrame?.({ width: frame.width, height: frame.height })
      },
      schedule: (callback) => {
        const request = requestAnimationFrame(callback)
        return () => cancelAnimationFrame(request)
      },
      onError: (e) => this.onError(e),
      isConnected: () => this.engine.isConnected(),
    })
    this.resizeObserver = new ResizeObserver(() => {
      this.showCanvasAtDevicePixels()
      this.scheduleSync()
    })
    this.resizeObserver.observe(container)
    this.showCanvasAtDevicePixels()
    this.watchDevicePixelRatio()
  }

  /** Starts showing frames (once connected): sends the size first, so the first frame is already the right size */
  start(): void {
    if (this.scheduler.isRunning || this.disposed) return
    this.syncSize(true)
    this.scheduler.start()
  }

  stop(): void {
    this.scheduler.stop()
    this.setSentSize(null)
  }

  private setSentSize(size: PixelSize | null): void {
    this.sentSize = size
    this.hooks.onHostSize?.(size)
  }

  /** The view may have changed (the camera moved, the selected object did): ask for a frame */
  invalidate(): void {
    this.scheduler.invalidate()
  }

  /** The scheduler's frame requests so far (a test of idle cost reads it) */
  get requests(): number {
    return this.scheduler.requests
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
    this.hooks.onLayout?.()
  }

  /** Sends the container's device-pixel size to the engine, if it changed (or always, when forced) */
  private syncSize(force: boolean = false): void {
    if (!this.engine.isConnected()) {
      this.setSentSize(null)
      return
    }
    const rect = this.container.getBoundingClientRect()
    const size = viewportPixelSize(rect.width, rect.height, window.devicePixelRatio)
    if (!size) return // hidden
    if (!force && this.sentSize?.width === size.width && this.sentSize?.height === size.height) return

    this.setSentSize(size)
    this.engine.setViewportSize(size.width, size.height).then(
      () => {
        // The host's frame changed with its size (it says so in an event too; this needn't wait for the poll)
        this.scheduler.invalidate()
      },
      (e) => {
        console.error("Failed to set viewport size:", e)
        this.setSentSize(null)
      }
    )
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
