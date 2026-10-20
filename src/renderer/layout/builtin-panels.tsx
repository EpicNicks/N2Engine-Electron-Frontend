// The editor's panels, registered: where each starts and what may be done with it. The panels themselves are untouched
// (each is the component that was mounted by hand before); a new panel is one more entry here.
import { ComponentType } from "preact"
import { AssetsPanel } from "../assets-panel"
import { ConsolePanel } from "../console-panel"
import { HierarchyPanel } from "../hierarchy-panel"
import { InspectorPanel } from "../inspector-panel"
import { EnginePanel } from "../panels"
import { Viewport } from "../viewport-panel"
import { PanelRegistry } from "./panel-registry"

type PanelComponent = ComponentType<Record<string, never>>

export function builtinPanels(): PanelRegistry<PanelComponent> {
  const registry = new PanelRegistry<PanelComponent>()
  registry.register({
    id: "assets",
    title: "Assets",
    icon: "📁",
    component: AssetsPanel as PanelComponent,
    defaultRegion: "left",
    closable: true,
    singleton: true,
  })
  // The viewport is the editor's centre: it can't be closed, so a stale layout can never hide it. Its frame loop runs
  // only while it is shown: a hidden viewport is unmounted (its renderer stops asking the host for frames), not paused
  registry.register({
    id: "viewport",
    title: "Viewport",
    component: Viewport as PanelComponent,
    defaultRegion: "center",
    closable: false,
    singleton: true,
    unmountWhenHidden: true,
  })
  registry.register({
    id: "console",
    title: "Console",
    component: ConsolePanel as PanelComponent,
    defaultRegion: "bottom",
    closable: true,
    singleton: true,
    tabBar: "always",
    unmountWhenHidden: true,
  })
  // The right region stacks three panels, each as high as it always was
  registry.register({
    id: "hierarchy",
    title: "Hierarchy",
    icon: "🎬",
    component: HierarchyPanel as PanelComponent,
    defaultRegion: "right",
    defaultGroup: 0,
    closable: true,
    singleton: true,
    sizing: { flex: "0 0 30%" },
  })
  registry.register({
    id: "inspector",
    title: "Inspector",
    icon: "⚙️",
    component: InspectorPanel as PanelComponent,
    defaultRegion: "right",
    defaultGroup: 1,
    closable: true,
    singleton: true,
  })
  registry.register({
    id: "engine",
    title: "Engine",
    icon: "🩺",
    component: EnginePanel as PanelComponent,
    defaultRegion: "right",
    defaultGroup: 2,
    closable: true,
    singleton: true,
    sizing: { flex: "0 0 auto", maxHeight: "30%" },
  })
  return registry
}
