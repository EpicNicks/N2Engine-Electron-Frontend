// The viewport panel: the engine's frame on a canvas, with the gizmo and the selection box drawn over it on a second
// canvas, and the mouse and keys turned into calls on ViewportController (viewport-controller.ts), whose maths and
// logic are unit tested. This file is DOM glue only. Controls: viewport-input.ts.
import { useEffect, useRef } from "preact/hooks"
import { effect, untracked } from "@preact/signals-core"
import { isTextEntry } from "./edit-actions"
import { useApp } from "./ui"
import { Axis, GizmoLayout } from "./viewport-gizmo"
import { FlyKeys, pointerActionFor, shortcutFor, wheelPixels, PointerAction } from "./viewport-input"
import { ViewportRenderer } from "./viewport-renderer"

const AxisColors: Readonly<Record<Axis, string>> = { x: "#e5484d", y: "#46a758", z: "#3e63dd" }
const AxisHighlight: Readonly<Record<Axis, string>> = { x: "#ff9592", y: "#8eda9a", z: "#8da4ef" }

/** One mouse gesture in progress */
interface Gesture {
  action: PointerAction
  pointerId: number
  lastX: number
  lastY: number
}

function drawGizmo(ctx: CanvasRenderingContext2D, layout: GizmoLayout, active: Axis | null, ratio: number): void {
  ctx.lineCap = "round"
  for (const handle of layout.handles) {
    const lit = handle.axis === active
    const color = lit ? AxisHighlight[handle.axis] : AxisColors[handle.axis]
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = (lit ? 4 : 3) * ratio
    ctx.beginPath()
    ctx.moveTo(handle.from.x, handle.from.y)
    ctx.lineTo(handle.to.x, handle.to.y)
    ctx.stroke()
    // An arrow head, along the handle
    const angle = Math.atan2(handle.to.y - handle.from.y, handle.to.x - handle.from.x)
    const head = 11 * ratio
    ctx.beginPath()
    ctx.moveTo(handle.to.x + Math.cos(angle) * head * 0.6, handle.to.y + Math.sin(angle) * head * 0.6)
    ctx.lineTo(handle.to.x - Math.cos(angle - 0.45) * head * 0.7, handle.to.y - Math.sin(angle - 0.45) * head * 0.7)
    ctx.lineTo(handle.to.x - Math.cos(angle + 0.45) * head * 0.7, handle.to.y - Math.sin(angle + 0.45) * head * 0.7)
    ctx.closePath()
    ctx.fill()
  }
  ctx.fillStyle = "#ffffff"
  ctx.beginPath()
  ctx.arc(layout.origin.x, layout.origin.y, 3 * ratio, 0, Math.PI * 2)
  ctx.fill()
}

export function Viewport() {
  const { store, scene, hierarchy, viewport } = useApp()
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const host = container.current!
    const frame = canvas.current!
    const over = overlay.current!
    const keys = new FlyKeys()
    let gesture: Gesture | null = null
    let boost = false
    let flyFrame: number | null = null
    let flyTime = 0

    const renderer = new ViewportRenderer(
      frame,
      host,
      window.engine,
      // A failed frame stops showing frames until the next connection; usually the connection just dropped, so it's a
      // console line rather than an error banner
      (e) => store.console.note("error", `Rendering stopped: ${e instanceof Error ? e.message : String(e)}`),
      {
        onSized: (size) => {
          viewport.setSize(size)
          void viewport.verifyMatrices()
        },
        onLayout: () => layoutOverlay(),
      }
    )

    /** The overlay lies exactly over the frame */
    function layoutOverlay(): void {
      if (over.width !== frame.width) over.width = frame.width
      if (over.height !== frame.height) over.height = frame.height
      over.style.width = frame.style.width
      over.style.height = frame.style.height
      over.style.left = frame.style.left
      over.style.top = frame.style.top
      drawOverlay()
    }

    function drawOverlay(): void {
      const ctx = over.getContext("2d")
      if (!ctx) return
      ctx.clearRect(0, 0, over.width, over.height)
      const ratio = window.devicePixelRatio || 1
      untracked(() => {
        const edges = viewport.boxEdges()
        if (edges.length > 0) {
          ctx.strokeStyle = "rgba(255, 200, 80, 0.9)"
          ctx.lineWidth = ratio
          ctx.beginPath()
          for (const [a, b] of edges) {
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
          }
          ctx.stroke()
        }
        const layout = viewport.layout()
        if (layout) drawGizmo(ctx, layout, viewport.hoverAxis.peek(), ratio)
      })
    }

    /** A pointer event's position in frame pixels (the engine's viewport, top-left origin) */
    function framePixel(e: { clientX: number; clientY: number }): { x: number; y: number } {
      const rect = frame.getBoundingClientRect()
      return {
        x: ((e.clientX - rect.left) * frame.width) / Math.max(1, rect.width),
        y: ((e.clientY - rect.top) * frame.height) / Math.max(1, rect.height),
      }
    }

    const reportFailure = (what: string) => (e: unknown) => store.reportError(what, e)

    // ---- Fly: the keys move the camera while the right button is down ----
    function flyTick(now: number): void {
      flyFrame = null
      if (gesture?.action !== "look") return
      const dt = Math.min(0.1, (now - flyTime) / 1000)
      flyTime = now
      if (keys.any) viewport.fly(keys.direction(), dt, boost)
      flyFrame = requestAnimationFrame(flyTick)
    }

    function endGesture(): void {
      const ended = gesture
      gesture = null
      keys.clear()
      if (flyFrame !== null) cancelAnimationFrame(flyFrame)
      flyFrame = null
      host.style.cursor = ""
      if (ended?.action === "select") void viewport.cancel().catch(reportFailure("Failed to end the move"))
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (gesture || !store.connected.peek()) return
      const action = pointerActionFor(e.button, e)
      if (action === "none") return
      e.preventDefault()
      host.focus()
      host.setPointerCapture(e.pointerId)
      gesture = { action, pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY }
      if (action === "select") {
        viewport.pointerDown(framePixel(e), e.ctrlKey)
      } else if (action === "look") {
        host.style.cursor = "grabbing"
        flyTime = performance.now()
        boost = e.shiftKey
        flyFrame = requestAnimationFrame(flyTick)
      } else {
        host.style.cursor = "grabbing"
      }
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!gesture || gesture.pointerId !== e.pointerId) {
        if (!gesture) viewport.hover(store.connected.peek() ? framePixel(e) : null)
        return
      }
      const dx = e.clientX - gesture.lastX
      const dy = e.clientY - gesture.lastY
      gesture.lastX = e.clientX
      gesture.lastY = e.clientY
      const ratio = window.devicePixelRatio || 1
      switch (gesture.action) {
        case "select":
          viewport.pointerMove(framePixel(e), e.ctrlKey)
          return
        case "orbit":
          viewport.orbit(dx, dy)
          break
        case "look":
          boost = e.shiftKey
          viewport.look(dx, dy)
          break
        case "pan":
          viewport.pan(dx * ratio, dy * ratio)
          break
        case "dolly":
          viewport.zoom(-dy * 3)
          break
      }
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (!gesture || gesture.pointerId !== e.pointerId) return
      const ended = gesture
      gesture = null
      keys.clear()
      if (flyFrame !== null) cancelAnimationFrame(flyFrame)
      flyFrame = null
      host.style.cursor = ""
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId)
      if (ended.action === "select") viewport.pointerUp(framePixel(e)).catch(reportFailure("Failed to end the move"))
    }

    const onWheel = (e: WheelEvent): void => {
      if (!store.connected.peek()) return
      e.preventDefault()
      viewport.zoom(wheelPixels(e.deltaY, e.deltaMode))
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTextEntry(e.target as HTMLElement | null)) return
      boost = e.shiftKey
      if (e.code === "Escape" && gesture?.action === "select") {
        e.preventDefault()
        endGesture()
        return
      }
      if (gesture?.action === "look" && keys.down(e.code)) {
        e.preventDefault()
        return
      }
      if (shortcutFor(e) === "frameSelected") {
        e.preventDefault()
        viewport.frameSelected().catch(reportFailure("Failed to frame the selection"))
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      boost = e.shiftKey
      keys.up(e.code)
    }
    const onBlur = (): void => {
      keys.clear()
      if (gesture) endGesture()
    }
    const onContextMenu = (e: Event): void => e.preventDefault()

    host.addEventListener("pointerdown", onPointerDown)
    host.addEventListener("pointermove", onPointerMove)
    host.addEventListener("pointerup", onPointerUp)
    host.addEventListener("pointercancel", onBlur)
    host.addEventListener("wheel", onWheel, { passive: false })
    host.addEventListener("keydown", onKeyDown)
    host.addEventListener("keyup", onKeyUp)
    host.addEventListener("blur", onBlur)
    host.addEventListener("contextmenu", onContextMenu)
    host.addEventListener("pointerleave", () => !gesture && viewport.hover(null))

    viewport.onFrameNeeded(() => renderer.invalidate())
    const stops = [
      // The connection: frames, and the camera that starts where the host's is
      effect(() => {
        if (store.connected.value) {
          untracked(() => {
            renderer.start()
            void viewport.connected()
          })
        } else {
          untracked(() => {
            renderer.stop()
            viewport.disconnected()
          })
        }
      }),
      // The selected object is the gizmo's
      effect(() => {
        const id = scene.selectedId.value
        untracked(() => void viewport.loadTarget(store.connected.peek() ? id : null))
      }),
      // The scene changed (an inspector edit, an undo, a rename): the selected object is read again
      effect(() => {
        store.sceneChangeCount.value // what this runs on
        const change = store.lastSceneChange.peek()
        untracked(() => {
          if (change && store.connected.peek()) viewport.objectsChanged(change.entityIds, change.full)
        })
      }),
      // The host says the view changed (frameChanged), or a scene change may have: ask for a frame
      effect(() => {
        store.frameChangeCount.value
        store.sceneChangeCount.value // what this runs on
        untracked(() => renderer.invalidate())
      }),
      // The overlay follows the gizmo, the selection and the camera
      effect(() => {
        viewport.overlayVersion.value
        viewport.target.value
        viewport.selectionBounds.value
        store.canEdit.value // the gizmo is for editing only
        drawOverlay()
      }),
    ]

    return () => {
      stops.forEach((stop) => stop())
      viewport.onFrameNeeded(null)
      if (flyFrame !== null) cancelAnimationFrame(flyFrame)
      host.removeEventListener("pointerdown", onPointerDown)
      host.removeEventListener("pointermove", onPointerMove)
      host.removeEventListener("pointerup", onPointerUp)
      host.removeEventListener("pointercancel", onBlur)
      host.removeEventListener("wheel", onWheel)
      host.removeEventListener("keydown", onKeyDown)
      host.removeEventListener("keyup", onKeyUp)
      host.removeEventListener("blur", onBlur)
      host.removeEventListener("contextmenu", onContextMenu)
      renderer.dispose()
    }
  }, [])

  const connected = store.connected.value
  return (
    <div class="viewport-container" ref={container} tabIndex={0} aria-label="Viewport">
      <canvas class="viewport" ref={canvas} width={800} height={600} />
      <canvas class="viewport-overlay-canvas" ref={overlay} width={800} height={600} />
      {!connected && <div class="viewport-overlay">{store.busy.value ?? store.hostSummary.value}</div>}
      {connected && !store.scene.value && (
        <div class="viewport-hint">No scene loaded: open one with Open scene, or make one with New scene</div>
      )}
      {connected && store.scene.value && (
        <div class="viewport-tools">
          <button
            class="secondary"
            title="Frame the selected object (F)"
            disabled={scene.selectedId.value === null}
            onClick={() => {
              viewport
                .frameSelected()
                .catch((e) => store.reportError("Failed to frame the selection", e))
              container.current?.focus()
            }}
          >
            Frame
          </button>
          <span
            class="viewport-help"
            title={
              "Alt+left drag: orbit. Middle drag: pan. Wheel: zoom. Hold right button: look, with W A S D Q E to fly " +
              "(Shift: faster). F: frame the selection. Drag a gizmo handle to move the selected object (Ctrl: snap, " +
              "Esc: cancel)."
            }
          >
            Alt+drag orbit · MMB pan · wheel zoom · RMB+WASD fly · F frame
          </span>
          {!viewport.canPick && (
            <span class="viewport-help" title="Clicking an object to select it needs the engine's PickEntity (E7b), which this host doesn't have yet: select in the hierarchy">
              Click-to-select: awaiting engine E7b
            </span>
          )}
        </div>
      )}
    </div>
  )
}
