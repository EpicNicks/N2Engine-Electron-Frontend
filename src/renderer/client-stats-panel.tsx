import { useEffect, useState } from "preact/hooks"
import type { AudioPlayerStatus } from "./audio-player"
import { ClientStatsRefreshMs, ClientStatsSnapshot } from "./client-stats"
import { useApp } from "./ui"

const value = (n: number | null, unit: string): string => n === null ? "—" : `${n.toFixed(1)} ${unit}`
const bytes = (n: number | null): string => n === null ? "—" :
  n < 1024 ? `${n.toFixed(0)} B/s` : `${(n / 1024).toFixed(1)} KiB/s`

/** Kept separate from the sampler so rendering unavailable and measured-zero values is testable without timers. */
export function ClientStatsView(props: { stats: ClientStatsSnapshot; audio: AudioPlayerStatus | null }) {
  const stats = props.stats
  const audio = props.audio
  const audioLive = audio !== null && (audio.state === "playing" || audio.state === "muted" || audio.state === "suspended")
  if (!stats.connected) return null
  const rows: Array<[string, string]> = [
    ["Editor frame request", value(stats.editorRequestMs, "ms")],
    ["Editor pixel payload", bytes(stats.editorPixelBytesPerSecond)],
    [`Displayed ${stats.frameSource === "game" ? "game" : "editor"} frames`, value(stats.displayedFramesPerSecond, "fps")],
    ["Event poll round trip", value(stats.eventPollMs, "ms")],
    ["Since last event poll", value(stats.eventPollAgeMs, "ms")],
    ["Audio buffer", audioLive ? value(audio.bufferedMs, "ms") : "—"],
    ["Audio underruns", audioLive ? String(audio.underruns) : "—"],
    ["Game frame progress", value(stats.playFramesPerSecond, "frames/s")],
    ["Game clock progress", value(stats.playTimePerSecond, "s/s")],
  ]
  return (
    <section class="client-stats" aria-label="Client statistics">
      <h3>Client statistics</h3>
      <dl>
        {rows.map(([label, result]) => <div key={label}><dt>{label}</dt><dd>{result}</dd></div>)}
      </dl>
      <p>Recent client measurements (up to 5 s). Pixel payload excludes protocol headers. Poll timing is a round trip,
        not a host CPU time or the age of a remote event. — means no current measurement.</p>
    </section>
  )
}

export function ClientStatsPanel() {
  const { store, audio } = useApp()
  const connected = store.connected.value
  const [stats, setStats] = useState(() => store.clientStats.snapshot())
  useEffect(() => {
    setStats(store.clientStats.snapshot())
    if (!connected) return
    const timer = setInterval(() => setStats(store.clientStats.snapshot()), ClientStatsRefreshMs)
    return () => clearInterval(timer)
  }, [connected, store.clientStats])
  if (!connected) return null
  return <ClientStatsView stats={stats} audio={audio.status.value} />
}
