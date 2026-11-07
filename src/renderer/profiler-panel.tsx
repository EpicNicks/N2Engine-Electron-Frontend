// The Profiler panel (FE-S5, protocol 1.28.0): where the active host's frames go (GetEngineStats), as a stacked graph of
// the recent frames and a breakdown table, and what it holds (render counters, scene, Lua, physics, process memory).
// The polling and the history are ProfilerModel's (profiler-state.ts); this draws them. The panel is unmounted while
// hidden (builtin-panels.tsx), and it polls only while mounted.
import { useEffect, useMemo } from "preact/hooks"
import { computed } from "@preact/signals"
import {
  Absent,
  LuaMemoryWarnShare,
  Sections,
  formatBytes,
  formatCount,
  formatMs,
  frameTotalMs,
  luaMemoryShare,
  physicsBackendLabel,
  EngineStatsCapability,
} from "../protocol/engine-stats"
import type { EngineFrameRecord, EngineStats } from "../protocol/protocol.generated"
import { ProfilerModel, type ProfilerDeps, type ProfilerTarget } from "./profiler-state"
import { Empty, Panel, useApp } from "./ui"

/** How many of the newest frames the graph draws */
export const GraphFrames = 240

/** The graph's guide lines: 60 and 30 frames a second */
const GuideMs = [1000 / 60, 1000 / 30]

function recordText(r: EngineFrameRecord): string {
  const parts = [
    `Frame ${r.frame}`,
    `interval ${formatMs(r.intervalMs)}`,
    `frame ${formatMs(r.tickMs)}`,
    `fixed ${formatMs(r.fixedMs)} (${r.fixedTicks} ticks, physics ${formatMs(r.physicsMs)})`,
    `update ${formatMs(r.updateMs)}`,
    `audio ${formatMs(r.audioMs)}`,
    `render ${formatMs(r.renderMs)}`,
  ]
  if (r.commandsMs > 0) {
    parts.push(`commands ${formatMs(r.commandsMs)} (render request ${formatMs(r.renderRequestMs)}, readback ${formatMs(r.readbackMs)})`)
  }
  return parts.join("\n")
}

/** A stacked bar per frame (the newest GraphFrames), with 60 and 30 fps guide lines; hovering a bar names its record */
export function FrameGraph(props: { records: readonly EngineFrameRecord[] }) {
  const records = props.records.slice(-GraphFrames)
  const top = Math.max(GuideMs[1] * 1.2, ...records.map(frameTotalMs))
  const height = 100
  const y = (ms: number): number => height - (ms / top) * height
  return (
    <svg
      class="profiler-graph"
      role="img"
      aria-label={`Frame times of the last ${records.length} frames`}
      viewBox={`0 0 ${GraphFrames} ${height}`}
      preserveAspectRatio="none"
    >
      {records.map((r, i) => {
        const x = GraphFrames - records.length + i
        let base = 0
        return (
          <g key={r.frame} data-frame={r.frame}>
            <title>{recordText(r)}</title>
            {Sections.map((section) => {
              const ms = section.of(r)
              if (ms <= 0) return null
              const rect = <rect class={`profiler-${section.id}`} x={x} width={1} y={y(base + ms)} height={(ms / top) * height} />
              base += ms
              return rect
            })}
          </g>
        )
      })}
      {GuideMs.map((ms) => (
        <line key={ms} class="profiler-guide" x1={0} x2={GraphFrames} y1={y(ms)} y2={y(ms)} vector-effect="non-scaling-stroke" />
      ))}
    </svg>
  )
}

function Legend() {
  return (
    <ul class="profiler-legend" aria-label="Legend">
      {Sections.map((s) => (
        <li key={s.id}>
          <span class={`swatch profiler-${s.id}`} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  )
}

function Breakdown(props: { model: ProfilerModel }) {
  const summary = props.model.summary.value
  if (summary.frames === 0) return null
  const row = (label: string, timing: { avg: number; p95: number; max: number } | null, format: (n: number) => string = formatMs) => (
    <tr key={label}>
      <th scope="row">{label}</th>
      <td>{timing ? format(timing.avg) : Absent}</td>
      <td>{timing ? format(timing.p95) : Absent}</td>
      <td>{timing ? format(timing.max) : Absent}</td>
    </tr>
  )
  return (
    <table class="profiler-breakdown" aria-label="Frame time breakdown">
      <thead>
        <tr>
          <th scope="col">Over {summary.frames} frames</th>
          <th scope="col">avg</th>
          <th scope="col">p95</th>
          <th scope="col">max</th>
        </tr>
      </thead>
      <tbody>
        {row("Frame interval", summary.intervalMs)}
        {row("Frame (tick)", summary.tickMs)}
        {row("Fixed ticks per frame", summary.fixedTicks, (n) => n.toFixed(n % 1 === 0 ? 0 : 2))}
        {summary.sections.map(({ section, timing }) => row(section.label, timing))}
        {summary.commandsMs && row("Commands after the frame", summary.commandsMs)}
      </tbody>
    </table>
  )
}

/** The figures of the last answer; "—" for what the host did not send */
export function Counters(props: { stats: EngineStats }) {
  const { render, scene, lua, physics, process } = props.stats
  const share = luaMemoryShare(props.stats)
  const luaWarn = share !== null && share > LuaMemoryWarnShare
  const rows: Array<[string, string, string?]> = [
    ["Draw calls", render?.counters === false ? Absent : formatCount(render?.drawCalls)],
    ["Triangles", render?.counters === false ? Absent : formatCount(render?.triangles)],
    ["Vertices", render?.counters === false ? Absent : formatCount(render?.vertices)],
    ["Frame size", render && render.width > 0 ? `${render.width} × ${render.height}` : Absent],
    ["Objects", scene ? `${formatCount(scene.objects)} (${formatCount(scene.activeObjects)} active)` : Absent],
    ["Components", formatCount(scene?.components)],
    ["Lua components", formatCount(scene?.luaComponents)],
    [
      "Lua memory",
      lua ? `${formatBytes(lua.memoryBytes)}${share !== null ? ` of ${formatBytes(lua.memoryCapBytes)} (${Math.round(share * 100)}%)` : ""}` : Absent,
      luaWarn ? "warn" : undefined,
    ],
    ["Physics", physics ? physicsBackendLabel(physics.backend) : Absent],
    ["Bodies", physics?.bodies !== undefined ? `${formatCount(physics.bodies)} (${formatCount(physics.staticBodies)} static)` : Absent],
    ["Active bodies", formatCount(physics?.activeBodies)],
    ["Process memory", formatBytes(process?.workingSetBytes)],
    ["Peak process memory", formatBytes(process?.peakWorkingSetBytes)],
  ]
  return (
    <section class="profiler-counters" aria-label="Host counters">
      <dl>
        {rows.map(([label, value, cls]) => (
          <div key={label} class={cls} data-warn={cls === "warn" ? "true" : undefined}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {share !== null && (
        <div
          class={`profiler-meter${luaWarn ? " warn" : ""}`}
          role="meter"
          aria-label="Lua memory"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.min(1, share) * 100)}
        >
          <span style={{ width: `${Math.min(100, share * 100)}%` }} />
        </div>
      )}
      {render?.counters === false && <p class="detail">This renderer does not count its draws.</p>}
    </section>
  )
}

function hostText(stats: EngineStats): string {
  const host = stats.host
  const kind = host.kind === "play" ? "Play host" : "Edit host"
  const parts = [kind, host.state]
  if (host.renderer) parts.push(host.renderer)
  if (host.timeScale !== 1 && Number.isFinite(host.timeScale)) parts.push(`time scale ${host.timeScale}`)
  return parts.join(", ")
}

/** The panel over a model (the Profiler panel builds one over window.engine and window.play) */
export function ProfilerView(props: { model: ProfilerModel }) {
  const model = props.model
  const blocked = model.blockedReason
  const stats = model.latest.value
  const shown = model.shown.value
  const error = model.error.value
  const paused = model.paused.value
  const missed = model.missed.value

  let content
  if (blocked !== null) content = <Empty>{blocked}</Empty>
  else if (stats === null && error === null) content = <Empty>Loading...</Empty>
  else
    content = (
      <>
        {error !== null && <Empty error>Failed to get the engine stats: {error}</Empty>}
        {stats !== null && (
          <div class="profiler-host">
            <span>{hostText(stats)}</span>
            {stats.summary && stats.summary.windowFrames > 0 && (
              <span>
                {stats.summary.fps.toFixed(1)} fps over the host's last {stats.summary.windowFrames} frames
              </span>
            )}
          </div>
        )}
        {shown.length > 0 ? (
          <>
            <FrameGraph records={shown} />
            <Legend />
            <Breakdown model={model} />
            {missed > 0 && <p class="detail">{missed} frames came and went between two requests and are not in the history.</p>}
          </>
        ) : (
          stats !== null &&
          (stats.host.kind === "play" ? (
            <Empty>No frames yet: the host's frame timers have just been turned on.</Empty>
          ) : (
            <Empty>The edit host runs no game frames. Press Play to see where a game's frames go; the counters below are the editor's.</Empty>
          ))
        )}
        {stats !== null && <Counters stats={stats} />}
        <p class="detail">
          Host CPU times only (no GPU time). Render figures are the frames drawn for the editor viewport, not a shipped
          game's loop. The client's side of the loop is in the Engine panel's client statistics.
        </p>
      </>
    )

  return (
    <Panel
      title="Profiler"
      icon="⏱"
      class="profiler-panel"
      actions={
        <>
          <button onClick={() => model.setPaused(!paused)} disabled={blocked !== null} aria-pressed={paused}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button class="secondary" onClick={() => model.clear()} disabled={blocked !== null}>
            Clear
          </button>
        </>
      }
    >
      {content}
    </Panel>
  )
}

/** The registered panel: a model over the page's API, polling while the panel is mounted (shown) */
export function ProfilerPanel() {
  const { store, play } = useApp()
  const model = useMemo(() => {
    const deps: ProfilerDeps = {
      getEngineStats: (kind, sinceFrame) =>
        kind === "play" ? window.play.getEngineStats(sinceFrame) : window.engine.getEngineStats(sinceFrame),
      connected: store.connected,
      supported: computed(() => store.serverInfo.value?.capabilities.includes(EngineStatsCapability) === true),
      target: computed((): ProfilerTarget => ({ kind: play.live.value ? "play" : "edit", session: play.state.value.launch })),
      connection: store.serverInfo,
      hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
    }
    return new ProfilerModel(deps)
  }, [store, play])
  useEffect(() => {
    model.start()
    return () => model.stop()
  }, [model])
  return <ProfilerView model={model} />
}
