// The viewport panel: the engine's frame on a canvas, with the gizmo and the selection box drawn over it on a second
// canvas, and the mouse and keys turned into calls on ViewportController (viewport-controller.ts), whose maths and
// logic are unit tested. This file is DOM glue only. Controls: viewport-input.ts.
import { useEffect, useRef } from "preact/hooks"
import { effect, untracked } from "@preact/signals-core"
import { keymap } from "./keymap"
import { useApp } from "./ui"
import { GizmoLayout, PlaneAxes } from "./viewport-gizmo"
import type { AnyHandle } from "./viewport-controller"
import { RotateLayout } from "./viewport-rotate"
import { ScaleLayout } from "./viewport-scale"
import { followViewportSelection } from "./viewport-selection"
import { pointerActionFor, wheelPixels, PointerAction } from "./viewport-input"
import { MarqueeOp, Rect, selectGesture } from "./viewport-marquee"
import { ViewportKeyboard } from "./viewport-keys"
import { ViewportViewMenu } from "./viewport-view-menu"
import { ViewportToolbar } from "./viewport-toolbar"
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

function drawGizmo(ctx: CanvasRenderingContext2D, layout: GizmoLayout, active: AnyHandle | null, ratio: number): void {
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

/** The rotate gizmo: a ring per axis; the half that faces the camera is strong (and the one that can be grabbed), the other faint */
function drawRotate(ctx: CanvasRenderingContext2D, layout: RotateLayout, active: AnyHandle | null, ratio: number): void {
  ctx.lineCap = "round"
  for (const ring of layout.rings) {
    const lit = ring.axis === active
    ctx.strokeStyle = lit ? AxisHighlight[ring.axis] : AxisColors[ring.axis]
    for (const front of [false, true]) {
      ctx.globalAlpha = front ? 1 : 0.25
      ctx.lineWidth = (front ? (lit ? 4 : 3) : 1.5) * ratio
      ctx.beginPath()
      for (const segment of ring.segments) {
        if (segment.front !== front) continue
        ctx.moveTo(segment.from.x, segment.from.y)
        ctx.lineTo(segment.to.x, segment.to.y)
      }
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1
  ctx.fillStyle = "#ffffff"
  ctx.beginPath()
  ctx.arc(layout.origin.x, layout.origin.y, 3 * ratio, 0, Math.PI * 2)
  ctx.fill()
}

/** The scale gizmo: an axis line with a cube at its end along each of the object's own axes, and a square at the centre for all three */
function drawScale(ctx: CanvasRenderingContext2D, layout: ScaleLayout, active: AnyHandle | null, ratio: number): void {
  ctx.lineCap = "round"
  const cube = 5 * ratio
  for (const handle of layout.handles) {
    const lit = handle.axis === active || active === "uniform"
    const color = lit ? AxisHighlight[handle.axis] : AxisColors[handle.axis]
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = (lit ? 4 : 3) * ratio
    ctx.beginPath()
    ctx.moveTo(handle.from.x, handle.from.y)
    ctx.lineTo(handle.to.x, handle.to.y)
    ctx.stroke()
    ctx.fillRect(handle.to.x - cube, handle.to.y - cube, cube * 2, cube * 2)
  }
  const half = 7 * ratio
  ctx.fillStyle = active === "uniform" ? "#ffffff" : "#c8c8c8"
  ctx.fillRect(layout.origin.x - half, layout.origin.y - half, half * 2, half * 2)
}

/** The marquee: a translucent rectangle, its outline dashed while Alt (fully inside) is held; a sign for add or remove */
function drawMarquee(ctx: CanvasRenderingContext2D, shape: { rect: Rect; inside: boolean; op: MarqueeOp }, ratio: number): void {
  const { minX, minY, maxX, maxY } = shape.rect
  ctx.fillStyle = "rgba(80, 160, 255, 0.15)"
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY)
  ctx.strokeStyle = "rgba(80, 160, 255, 0.9)"
  ctx.lineWidth = ratio
  ctx.setLineDash(shape.inside ? [4 * ratio, 3 * ratio] : [])
  ctx.strokeRect(minX + 0.5, minY + 0.5, maxX - minX, maxY - minY)
  ctx.setLineDash([])
  if (shape.op !== "replace") {
    ctx.font = `${12 * ratio}px sans-serif`
    ctx.textBaseline = "top"
    ctx.fillStyle = "#ffffff"
    ctx.fillText(shape.op === "add" ? "+" : "-", maxX + 4 * ratio, maxY + 2 * ratio)
  }
}

/** What a drag has made so far ("X +37.5 deg"), beside the gizmo */
function drawReadout(ctx: CanvasRenderingContext2D, text: string, at: { x: number; y: number }, ratio: number): void {
  ctx.font = `${12 * ratio}px sans-serif`
  ctx.textBaseline = "bottom"
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)"
  const width = ctx.measureText(text).width
  ctx.fillRect(at.x + 12 * ratio, at.y - 30 * ratio, width + 8 * ratio, 18 * ratio)
  ctx.fillStyle = "#ffffff"
  ctx.fillText(text, at.x + 16 * ratio, at.y - 14 * ratio)
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
    // The fly keys and the viewport's shortcuts (viewport-keys.ts); the host adapter reads the gesture and the view
    const kb = new ViewportKeyboard({
      gesture: () => gesture?.action ?? null,
      endGesture: () => endGesture(),
      frameSelected: () => viewport.frameSelected().catch(reportFailure("Failed to frame the selection")),
      live: () => play.live.peek(),
      setMode: (mode) => viewport.setMode(mode),
      toggleSpace: () => viewport.toggleSpace(),
      togglePivot: () => viewport.togglePivot(),
      bookmark: (slot,save) => viewport.bookmark(slot,save),
      axisView: axis => viewport.setAxis(axis),
      toggleOrthographic: () => viewport.setOrthographic(!viewport.camera.orthographic),
      toggle2D: () => viewport.set2D(!viewport.camera.mode2D),
    })
    let gesture: Gesture | null = null
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
        stats: store.clientStats,
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
        viewport.drawSceneOverlays(ctx,over.width,over.height,ratio)
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
        const hover = viewport.hoverHandle.peek()
        const mode = viewport.mode.peek()
        let origin: { x: number; y: number } | null = null
        if (mode === "translate") {
          const layout = viewport.layout()
          if (layout) drawGizmo(ctx, layout, hover, ratio)
        } else if (mode === "rotate") {
          const layout = viewport.rotateLayout()
          if (layout) {
            drawRotate(ctx, layout, hover, ratio)
            origin = layout.origin
          }
        } else if (mode === "scale") {
          const layout = viewport.scaleLayout()
          if (layout) {
            drawScale(ctx, layout, hover, ratio)
            origin = layout.origin
          }
        }
        const readout = origin ? viewport.dragReadout() : null
        if (origin && readout) drawReadout(ctx, readout, origin, ratio)
        const marquee = viewport.marqueeShape()
        if (marquee) drawMarquee(ctx, marquee, ratio)
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
      if (kb.keys.any) viewport.fly(kb.keys.direction(), dt, kb.boost)
      flyFrame = requestAnimationFrame(flyTick)
    }

    function endGesture(): void {
      const ended = gesture
      gesture = null
      kb.keys.clear()
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
        selectGesture.down(viewport, framePixel(e), e)
      } else if (action === "look") {
        host.style.cursor = "grabbing"
        flyTime = performance.now()
        kb.boost = e.shiftKey
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
          selectGesture.move(viewport, framePixel(e), e)
          return
        case "orbit":
          viewport.orbit(dx, dy)
          break
        case "look":
          kb.boost = e.shiftKey
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
      kb.keys.clear()
      if (flyFrame !== null) cancelAnimationFrame(flyFrame)
      flyFrame = null
      host.style.cursor = ""
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId)
      if (ended.action === "select") {
        // A click: Ctrl/Cmd and Shift both toggle the picked object, as in Unity's scene view (Ctrl at the press snaps a
        // gizmo drag). A marquee: Shift adds, Ctrl/Cmd removes, Alt takes only what is fully inside (viewport-marquee.ts)
        selectGesture.up(viewport, framePixel(e), e).catch(reportFailure("Failed to end the move"))
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
      // A fly key while looking is taken here (and prevented, so no shortcut takes it too); F and Escape are the keymap's
      // (viewport.frame, viewport.cancel), registered below
      if (kb.keyDown(e)) e.preventDefault()
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (play.live.peek()) {
        if (forwarder.key(e.code, false)) e.preventDefault()
        return
      }
      kb.keyUp(e)
    }
    const onBlur = (): void => {
      // Focus left the game view (or the window): nothing stays held down in the game
      forwarder.releaseAll()
      kb.keys.clear()
      if (gesture) endGesture()
    }
    const onContextMenu = (e: Event): void => e.preventDefault()

    host.addEventListener("pointerdown", onPointerDown)
    host.addEventListener("pointermove", onPointerMove)
    host.addEventListener("pointerup", onPointerUp)
    host.addEventListener("pointercancel", onBlur)
    host.addEventListener("wheel", onWheel, { passive: false })
    const unregisterKeys = kb.register(keymap, host)
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
        viewport.viewPreferences.value
        hierarchy.response.value
        viewport.mode.value
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
      unregisterKeys()
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
    <div class="viewport-container" ref={container} tabIndex={0} aria-label="Viewport" data-keymap-scope="viewport">
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
          <ViewportViewMenu key={store.scene.value?.uuid ?? ""} viewport={viewport} enabled={!play.live.value && connected} onUsed={() => container.current?.focus()} />
          <ViewportToolbar viewport={viewport} canEdit={store.canEdit.value} onUsed={() => container.current?.focus()} />
          <span
            class="viewport-help"
            title={
              "Alt+left drag: orbit. Middle drag: pan. Wheel: zoom. Hold right button: look, with W A S D Q E to fly " +
              "(Shift: faster). F: frame the selection. W E R Q: move, rotate, scale, select only. X: world or local space. Z: pivot or center. " +
              "Click: select (Ctrl or Shift: add or remove; empty space clears). " +
              "Drag on empty space: marquee select (Shift: add, Ctrl: remove, Alt while dragging: only what is fully inside, Esc: cancel). " +
              "Drag a gizmo handle to change the selected objects (Ctrl: invert snapping, Esc: cancel)."
            }
          >
            Alt+drag orbit · MMB pan · wheel zoom · RMB+WASD fly · click/drag select · F frame
          </span>
        </div>
      )}
    </div>
  )
}
