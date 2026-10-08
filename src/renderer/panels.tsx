// The engine's health panel. The other panels have files of their own: the hierarchy (hierarchy-panel.tsx), the inspector
// (inspector-panel.tsx), the assets and the text editor (assets-panel.tsx), the viewport and the console.
import { useEffect, useState } from "preact/hooks"
import type { EngineHealthResponse } from "../protocol/protocol.generated"
import { Empty, Panel, useApp } from "./ui"

// ==================== Engine health ====================

export function EnginePanel() {
  const { store } = useApp()
  const connected = store.connected.value
  const info = store.serverInfo.value
  const [health, setHealth] = useState<EngineHealthResponse | null>(null)
  const [failed, setFailed] = useState(false)

  const refresh = () =>
    window.engine.getEngineHealth().then(
      (h) => {
        setHealth(h)
        setFailed(false)
      },
      (e) => {
        console.error("Failed to get engine health:", e)
        setFailed(true)
      }
    )
  useEffect(() => {
    setHealth(null)
    if (connected) refresh()
  }, [connected])

  let content
  if (!connected) content = <Empty>Not connected</Empty>
  else if (failed) content = <Empty error>Failed to get engine health</Empty>
  else if (!health) content = <Empty>Loading...</Empty>
  else
    content = (
      <>
        {info && (
          <div class="health-item">
            N2Engine {info.engineVersion}, protocol {info.protocolVersion}
            {!info.projectLoaded && <div class="detail">The host has no project loaded</div>}
          </div>
        )}
        {!health.healthy && <Empty error>A subsystem failed</Empty>}
        {health.subsystems.map((subsystem) => (
          <div class="health-item" key={subsystem.name}>
            <span>{subsystem.name}</span>
            <span
              class={`state ${subsystem.state === "Running" ? "running" : subsystem.state === "Failed" ? "failed" : "other"}`}
            >
              {subsystem.state}
            </span>
            {subsystem.detail && <div class="detail">{subsystem.detail}</div>}
          </div>
        ))}
      </>
    )

  return (
    <Panel
      title="Engine"
      icon="🩺"
      class="engine-panel"
      actions={
        <button onClick={refresh} disabled={!connected}>
          Refresh
        </button>
      }
    >
      {content}
    </Panel>
  )
}
