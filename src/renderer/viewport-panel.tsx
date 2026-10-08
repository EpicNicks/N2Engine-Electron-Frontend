// The viewport panel: the engine's frame on a canvas, with the gizmo and the selection box drawn over it on a second
// canvas, and the mouse and keys turned into calls on ViewportController (viewport-controller.ts), whose maths and
// logic are unit tested. This file is DOM glue only. Controls: viewport-input.ts.
import { useEffect, useRef } from "preact/hooks"
import { effect, untracked } from "@preact/signals-core"
import { isTextEntry } from "./edit-actions"
import { useApp } from "./ui"
import { HandleId, GizmoLayout, PlaneAxes } from "./viewport-gizmo"
import { followViewportSelection } from "./viewport-selection"
import { FlyKeys, pointerActionFor, shortcutFor, wheelPixels, PointerAction } from "./viewport-input"
import { InputForwarder, scrollLines } from "./play-input"
import { ViewportRenderer, editTarget, gameTarget } from "./viewport-renderer"
import { framePixelOf } from "./viewport-size"

const AxisColors: Readonly<Record<'x' | 'y' | 'z', string>> = { x: "#e5484d", y: "#46a758", z: "#3e63dd" }
const AxisHighlight: Readonly<Record<'x' | 'y' | 'z', string>> = { x: "#ff9592", y: "#8eda9a", z: "#8da4ef" }

/** One mouse gesture in progress */
interface Gesture {
  action: PointerAction
  pointerId: number
  lastX: number
  lastY: number
}

function drawGizmo(ctx: CanvasRenderingContext2D, layout: GizmoLayout, active: HandleId | null, ratio: number): void {
  ctx.lineCap = "round"
  // The plane squares first (the axes are drawn over them), each in the colour of the axis it is perpendicular to; they
  // fade as the plane turns edge-on, and the one under the pointer is brighter
  for (const handle of layout.planes) {
    const normal = PlaneAxes[handle.plane].normal
    const lit = handle.plane === active
    ctx.globalAlpha = handle.alpha * (lit ? 0.85 : 0.4)
    ctx.fillStyle = lit ? AxisHighlight[normal] : AxisColors[normal]
    ctx.beginPath()
    handle.corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)))
    ctx.closePath()
    ctx.fill()
    ctx.globalAlpha = handle.alpha
    ctx.strokeStyle = lit ? AxisHighlight[normal] : AxisColors[normal]
    ctx.lineWidth = ratio
    ctx.stroke()
  }
  ctx.globalAlpha = 1
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
  const { store, scene, hierarchy, viewport, play } = useApp()
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

    const edit = editTarget(window.engine)
    const game = gameTarget(window.play)
    // While a game is live the keys, buttons, pointer and wheel over the view go to the game (SendInput), not to the
    // editor camera, the gizmo or picking
    const forwarder = new InputForwarder({
      send: (events) => window.play.sendInput(events),
      schedule: (callback) => {
        const request = requestAnimationFrame(callback)
        return () => cancelAnimationFrame(request)
      },
      onError: (e) => void play.failure("Failed to send input to the game", e),
    })

    const renderer = new ViewportRenderer(
      frame,
      host,
      edit,
      // A failed frame stops showing frames until the next connection; usually the connection just dropped, so it's a
      // console line rather than an error banner. A game's frame fails when the game ended, which isn't news: its state
      // says so (and a failure while it still runs is shown).
      (e) =>
        renderer.targetKind === "game"
          ? void play.failure("The game's picture stopped", e)
          : store.console.note("error", `Rendering stopped: ${e instanceof Error ? e.message : String(e)}`),
      {
        onFrame: (size) => {
          viewport.setPixelRatio(window.devicePixelRatio || 1)
          if (viewport.setSize(size)) void viewport.verifyMatrices()
        },
        onLayout: () => layoutOverlay(),
        onHostSize: (size) => viewport.setHostSize(size),
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
      // The game's picture has no gizmo or selection box (they are the editor camera's)
      if (play.live.peek()) return
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
        if (layout) drawGizmo(ctx, layout, viewport.hoverHandle.peek(), ratio)
      })
    }

    /** A pointer event's position in frame pixels (the engine's viewport, top-left origin) */
    function framePixel(e: { clientX: number; clientY: number }): { x: number; y: number } {
      return framePixelOf({ x: e.clientX, y: e.clientY }, frame.getBoundingClientRect(), frame)
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

    /** The pointer over the game's picture: the position, and the button */
    const playPointer = (e: PointerEvent, button: "down" | "up" | "move"): void => {
      const pixel = framePixel(e)
      forwarder.pointer(pixel.x, pixel.y)
      if (button === "down") forwarder.mouseButton(e.button, true)
      else if (button === "up") forwarder.mouseButton(e.button, false)
    }

    const onPointerDown = (e: PointerEvent): void => {
      // The controls over the viewport (Frame, the help) are the page's, not the viewport's
      if ((e.target as Element | null)?.closest?.(".viewport-tools")) return
      if (play.live.peek()) {
        e.preventDefault()
        host.focus()
        host.setPointerCapture(e.pointerId)
        playPointer(e, "down")
        return
      }
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
      if (play.live.peek()) return playPointer(e, "move")
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
      if (play.live.peek()) {
        if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId)
        return playPointer(e, "up")
      }
      if (!gesture || gesture.pointerId !== e.pointerId) return
      const ended = gesture
      gesture = null
      keys.clear()
      if (flyFrame !== null) cancelAnimationFrame(flyFrame)
      flyFrame = null
      host.style.cursor = ""
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId)
      if (ended.action === "select") {
        // Ctrl/Cmd and Shift both toggle the picked object, as in Unity's scene view (a click, not a drag: Ctrl at the
        // press snaps)
        viewport
          .pointerUp(framePixel(e), { toggle: e.ctrlKey || e.metaKey || e.shiftKey })
          .catch(reportFailure("Failed to end the move"))
      }
    }

    const onWheel = (e: WheelEvent): void => {
      if (play.live.peek()) {
        e.preventDefault()
        const lines = scrollLines(e.deltaX, e.deltaY, e.deltaMode)
        forwarder.scroll(lines.x, lines.y)
        return
      }
      if (!store.connected.peek()) return
      e.preventDefault()
      if (viewport.isDragging) return // the camera stays where the drag began
      viewport.zoom(wheelPixels(e.deltaY, e.deltaMode))
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (play.live.peek()) {
        // Ctrl+Escape leaves the game view (keyboard users aren't trapped in it), and Tab keeps moving the focus
        if (e.code === "Escape" && e.ctrlKey) {
          e.preventDefault()
          forwarder.releaseAll()
          host.blur()
          return
        }
        if (e.code === "Tab") return
        // A key the engine names is the game's (and not the page's: Ctrl+S does nothing here); a repeat is a held key
        if (forwarder.key(e.code, true)) e.preventDefault()
        return
      }
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
      if (play.live.peek()) {
        if (forwarder.key(e.code, false)) e.preventDefault()
        return
      }
      boost = e.shiftKey
      keys.up(e.code)
    }
    const onBlur = (): void => {
      // Focus left the game view (or the window): nothing stays held down in the game
      forwarder.releaseAll()
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
    const onPointerLeave = (): void => {
      if (!gesture) viewport.hover(null)
    }
    host.addEventListener("pointerleave", onPointerLeave)

    viewport.onFrameNeeded(() => renderer.invalidate())
    // The selection is the gizmo's (its primary object places it, the topmost selected objects move with it), and the
    // scene's changes reach it
    const follow = followViewportSelection({ store, hierarchy, viewport })
    const stops = [
      // The connection: frames, and the camera that starts where the host's is
      effect(() => {
        if (store.connected.value) {
          untracked(() => {
            follow.forget()
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
      follow.stop,
      // Picking needs an open scene and a host that has it: when either changes, the boxes are asked for (or dropped)
      effect(() => {
        store.scene.value
        store.serverInfo.value
        untracked(() => viewport.reloadBounds())
      }),
      // The host says the view changed (frameChanged), or a scene change may have: ask for a frame
      effect(() => {
        store.frameChangeCount.value
        store.sceneChangeCount.value // what this runs on
        untracked(() => renderer.invalidate())
      }),
      // A game going live shows its frames instead of the editor view's, and takes the keys (the view is focused); the
      // editor view returns, and the keys are the camera's again, when it ends
      effect(() => {
        const live = play.live.value
        untracked(() => {
          if (gesture) endGesture()
          forwarder.reset()
          renderer.setTarget(live ? game : edit)
          if (live) host.focus()
          drawOverlay()
        })
      }),
      // The overlay follows the gizmo, the selection and the camera
      effect(() => {
        viewport.overlayVersion.value
        viewport.target.value
        viewport.selectionBounds.value // the selection's boxes
        store.canEdit.value // the gizmo is for editing only
        drawOverlay()
      }),
    ]

    return () => {
      stops.forEach((stop) => stop())
      forwarder.dispose()
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
      host.removeEventListener("pointerleave", onPointerLeave)
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
      {connected && store.scene.value && play.live.value && (
        <div class="viewport-tools">
          <span
            class="viewport-help"
            title="While this view has focus, the keys, the mouse buttons, the pointer and the wheel go to the game"
          >
            {play.paused.value ? "Game paused" : "Game"} · the keyboard and mouse are the game's while this view has focus (Ctrl+Esc leaves it)
          </span>
        </div>
      )}
      {connected && store.scene.value && !play.live.value && (
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
              "(Shift: faster). F: frame the selection. Click: select (Ctrl or Shift: add or remove; empty space clears). Drag a gizmo arrow or square to move " +
              "the selected objects (Ctrl: snap, Esc: cancel)."
            }
          >
            Alt+drag orbit · MMB pan · wheel zoom · RMB+WASD fly · click select · F frame
          </span>
        </div>
      )}
    </div>
  )
}
