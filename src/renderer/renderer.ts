import { AudioPlayer, AudioPlayerStatus } from "./audio-player"
import { basename, extname, join } from "./paths"
import { PixelSize, cssSizeForPixels, viewportPixelSize } from "./viewport-size"
import type { FileInfo } from "../shared/api"

// The page is sandboxed: window.engine (the engine connection) and window.project (the open project's files) are
// the typed IPC API the preload exposes (src/shared/api.ts); there is no Node here.

// ==================== State Management ====================
let selectedEntityId: string | null = null
let entities: Array<{ id: string; name: string }> = []
let currentProjectPath: string | null = null
let currentScene: string | null = null
let openScriptTabs: Map<string, string> = new Map()
let activeScriptTab: string | null = null
let collapsedFolders: Set<string> = new Set()
let contextMenuTarget: HTMLElement | null = null
let contextMenuPath: string | null = null

// ==================== Welcome Screen ====================
const welcomeScreen = document.getElementById("welcome-screen")!
const editor = document.getElementById("editor")!
const openProjectBtn = document.getElementById("openProjectBtn")!
const createProjectBtn = document.getElementById("createProjectBtn")!
const recentProjectsEl = document.getElementById("recent-projects")!

async function loadRecentProjects(): Promise<void> {
  const recent = await window.project.getRecent()
  if (recent.length === 0) {
    recentProjectsEl.innerHTML = '<h3>Recent Projects</h3><p style="color: #666;">No recent projects</p>'
    return
  }

  recentProjectsEl.innerHTML = "<h3>Recent Projects</h3>"
  recent.forEach((projectPath) => {
    // Paths are set as text, not HTML
    const item = document.createElement("div")
    item.className = "recent-item"
    item.title = projectPath
    item.textContent = basename(projectPath)
    item.addEventListener("click", async () => {
      try {
        await openProject(await window.project.openRecent(projectPath))
      } catch (e) {
        console.error("Failed to open project:", e)
        alert("Failed to open project: " + e)
      }
    })
    recentProjectsEl.appendChild(item)
  })
}

// Opening a project launches its editor host and connects to it (in the main process); the page only shows it
openProjectBtn.addEventListener("click", async () => {
  try {
    const projectPath = await window.project.openDialog()
    if (projectPath) await openProject(projectPath)
  } catch (e) {
    console.error("Failed to open project:", e)
    alert("Failed to open project: " + e)
  }
})

createProjectBtn.addEventListener("click", async () => {
  try {
    const projectPath = await window.project.createDialog()
    if (projectPath) await openProject(projectPath)
  } catch (e) {
    console.error("Failed to create project:", e)
    alert("Failed to create project: " + e)
  }
})

async function openProject(projectPath: string): Promise<void> {
  currentProjectPath = projectPath
  welcomeScreen.style.display = "none"
  editor.style.display = "flex"

  const projectNameEl = document.getElementById("project-name")!
  projectNameEl.textContent = basename(projectPath)

  await refreshFileTree()
  if (window.engine.isConnected()) await onConnected()
}

loadRecentProjects()

// ==================== Connection ====================
const connectBtn = document.getElementById("connectBtn") as HTMLButtonElement
const disconnectBtn = document.getElementById("disconnectBtn") as HTMLButtonElement
const statusEl = document.getElementById("status")!

async function onConnected(): Promise<void> {
  try {
    const info = window.engine.serverInfo()
    if (!info) return
    // Before the first RenderFrame (requests are answered in order), so the first frame is already the right size
    syncViewportSize(true)
    statusEl.textContent = "Connected"
    statusEl.title =
      `N2Engine ${info.engineVersion}, protocol ${info.protocolVersion}` +
      (info.projectLoaded ? "" : " (the host has no project loaded)")
    statusEl.classList.add("connected")
    connectBtn.disabled = true
    disconnectBtn.disabled = false

    await refreshSceneState()
    startRenderLoop()
    audio.start()
    refreshHealthBtn.disabled = false
    await refreshEngineHealth()
  } catch (e) {
    console.error("Failed to connect:", e)
    // E.g. the host refused Hello: a wrong access token, or an incompatible protocol version
    statusEl.textContent = "Connection failed"
    statusEl.title = e instanceof Error ? e.message : String(e)
  }
}

// The host exits when its session ends (--exit-on-disconnect), so connecting again means launching a new one
connectBtn.addEventListener("click", () => {
  window.host.restart().catch((e) => {
    console.error("Failed to restart the editor host:", e)
    statusEl.textContent = "Connection failed"
    statusEl.title = e instanceof Error ? e.message : String(e)
  })
})

function showDisconnected(status: string): void {
  audio.stop()
  statusEl.textContent = status
  statusEl.title = ""
  statusEl.classList.remove("connected")
  connectBtn.disabled = false
  disconnectBtn.disabled = true
  stopRenderLoop()
  refreshHealthBtn.disabled = true
  refreshEngineHealth()
}

disconnectBtn.addEventListener("click", async () => {
  try {
    await window.host.stop()
  } catch (e) {
    console.error("Failed to disconnect:", e)
  }
  showDisconnected("Disconnected")
})

// The host can drop the connection (it exited or crashed)
window.engine.onConnectionChange((connected) => {
  if (connected) {
    if (currentProjectPath) onConnected()
  } else if (!disconnectBtn.disabled) {
    showDisconnected("Connection lost")
  }
})

// ==================== Audio ====================
const muteBtn = document.getElementById("muteBtn") as HTMLButtonElement
const audioStatusEl = document.getElementById("audio-status")!
const MutedStorageKey = "audioMuted"

// Polls GetAudio through window.engine and plays it with Web Audio (see audio-player.ts)
const audio = new AudioPlayer({
  getAudio: () => window.engine.getAudio(),
  isConnected: () => window.engine.isConnected(),
})

let audioState: AudioPlayerStatus["state"] = "stopped"

function loadMutedSetting(): boolean {
  try {
    return localStorage.getItem(MutedStorageKey) === "true"
  } catch {
    return false
  }
}

function saveMutedSetting(muted: boolean): void {
  try {
    localStorage.setItem(MutedStorageKey, String(muted))
  } catch {
    // not persisted; the setting still applies for this session
  }
}

function updateMuteButton(): void {
  if (audioState === "suspended") {
    muteBtn.textContent = "🔇 Enable audio"
  } else {
    muteBtn.textContent = audio.isMuted ? "🔇 Unmute" : "🔊 Mute"
  }
}

muteBtn.addEventListener("click", () => {
  // A click is a user gesture, so unmuting also resumes audio the autoplay policy suspended
  const muted = audioState === "suspended" ? false : !audio.isMuted
  audio.setMuted(muted)
  saveMutedSetting(muted)
  updateMuteButton()
})

audio.setMuted(loadMutedSetting())

audio.onStatus((status) => {
  if (status.state !== audioState && (status.state === "error" || status.state === "unavailable")) {
    console.warn(`Audio ${status.state}: ${status.message}`)
  }
  audioState = status.state

  const format = status.sampleRate > 0 ? ` (${status.sampleRate / 1000} kHz ${status.sampleFormat})` : ""
  const problems = status.underruns + status.gaps > 0 ? `, ${status.underruns} underruns, ${status.gaps} gaps` : ""
  let text: string
  switch (status.state) {
    case "playing":
      text = `Audio: ${status.bufferedMs} ms buffered${format}${problems}`
      break
    case "muted":
      text = `Audio: muted${format}`
      break
    case "suspended":
      text = "Audio: paused until enabled"
      break
    case "unavailable":
      text = "Audio: none (engine not on a loopback device)"
      break
    case "error":
      text = `Audio error: ${status.message}`
      break
    default:
      text = "Audio: off"
  }
  audioStatusEl.textContent = text
  audioStatusEl.title = status.message
  audioStatusEl.classList.toggle("warning", status.state === "error" || status.state === "suspended")
  updateMuteButton()
})

// ==================== Engine Health ====================
const engineHealthEl = document.getElementById("engine-health")!
const refreshHealthBtn = document.getElementById("refreshHealthBtn") as HTMLButtonElement

refreshHealthBtn.addEventListener("click", refreshEngineHealth)

async function refreshEngineHealth(): Promise<void> {
  if (!window.engine.isConnected()) {
    engineHealthEl.innerHTML = '<p style="color: #666; padding: 10px;">Not connected</p>'
    return
  }

  try {
    const health = await window.engine.getEngineHealth()
    engineHealthEl.innerHTML = ""
    if (!health.healthy) {
      engineHealthEl.innerHTML = '<p style="color: #f44336; padding: 4px 8px;">A subsystem failed</p>'
    }

    // Details come from the engine, so they're set as text rather than HTML
    health.subsystems.forEach((subsystem) => {
      const itemEl = document.createElement("div")
      itemEl.className = "health-item"

      const name = document.createElement("span")
      name.textContent = subsystem.name
      itemEl.appendChild(name)

      const state = document.createElement("span")
      const stateClass = subsystem.state === "Running" ? "running" : subsystem.state === "Failed" ? "failed" : "other"
      state.className = `state ${stateClass}`
      state.textContent = subsystem.state
      itemEl.appendChild(state)

      if (subsystem.detail) {
        const detail = document.createElement("div")
        detail.className = "detail"
        detail.textContent = subsystem.detail
        itemEl.appendChild(detail)
      }

      engineHealthEl.appendChild(itemEl)
    })
  } catch (e) {
    console.error("Failed to get engine health:", e)
    engineHealthEl.innerHTML = '<p style="color: #f44336; padding: 10px;">Failed to get engine health</p>'
  }
}

// ==================== Scene State Management ====================
async function refreshSceneState(): Promise<void> {
  if (!window.engine.isConnected()) {
    currentScene = null
    updateUIForSceneState()
    return
  }

  try {
    const sceneData = await window.engine.getCurrentScene() // ← Returns SceneData now
    if (sceneData) {
      const sceneJson = JSON.parse(sceneData.sceneJson)
      currentScene = sceneJson.name || null
    } else {
      currentScene = null
    }
    updateUIForSceneState()

    if (currentScene) {
      await refreshHierarchy()
    }
  } catch (e) {
    console.error("Failed to get current scene:", e)
    currentScene = null
    updateUIForSceneState()
  }
}

function updateUIForSceneState(): void {
  const createEntityBtn = document.getElementById("createEntityBtn") as HTMLButtonElement
  const hierarchyEl = document.getElementById("hierarchy")!

  if (!currentScene) {
    createEntityBtn.disabled = true
    hierarchyEl.innerHTML = '<p style="color: #666; padding: 10px;">No scene loaded</p>'
    // Update status to show no scene
    if (window.engine.isConnected()) {
      statusEl.textContent = "Connected"
      statusEl.classList.add("connected")
    }
  } else {
    createEntityBtn.disabled = false
    if (entities.length === 0) {
      hierarchyEl.innerHTML = '<p style="color: #666; padding: 10px;">No entities in scene</p>'
    }
    // Update status to show scene name
    if (window.engine.isConnected()) {
      statusEl.textContent = `Connected - Scene: ${currentScene}`
      statusEl.classList.add("connected")
    }
  }
}

// ==================== File Tree ====================
const fileTreeEl = document.getElementById("file-tree")!

type FileTreeNode = FileInfo

let fileTree: FileTreeNode[] = []

/** Re-reads the project's files */
async function refreshFileTree(): Promise<void> {
  if (!currentProjectPath) return

  try {
    fileTree = await window.project.listFiles()
  } catch (e) {
    console.error("Failed to list the project's files:", e)
    fileTree = []
  }
  renderFileTree()
}

/** Redraws the tree from the last listing (folding a folder needn't re-read it) */
function renderFileTree(): void {
  fileTreeEl.innerHTML = ""
  fileTree.forEach((file) => renderFileNode(file, fileTreeEl, 0))
}

function renderFileNode(node: FileTreeNode, parentEl: HTMLElement, depth: number): void {
  const itemEl = document.createElement("div")
  itemEl.className = "file-item"
  itemEl.style.paddingLeft = `${depth * 12 + 6}px`
  itemEl.dataset.path = node.path
  itemEl.dataset.isDirectory = String(node.isDirectory)

  const isCollapsed = collapsedFolders.has(node.path)

  if (node.isDirectory) {
    const arrow = document.createElement("span")
    arrow.textContent = isCollapsed ? ">" : "v"
    arrow.style.width = "16px"
    arrow.style.display = "inline-block"
    arrow.style.fontSize = "10px"
    arrow.style.fontWeight = "bold"
    itemEl.appendChild(arrow)

    const icon = document.createElement("span")
    icon.className = "icon"
    icon.textContent = "📁"
    itemEl.appendChild(icon)

    const name = document.createElement("span")
    name.textContent = node.name
    itemEl.appendChild(name)

    itemEl.addEventListener("click", (e) => {
      e.stopPropagation()
      if (collapsedFolders.has(node.path)) {
        collapsedFolders.delete(node.path)
      } else {
        collapsedFolders.add(node.path)
      }
      renderFileTree()
    })

    itemEl.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      e.stopPropagation()
      showContextMenu(e.clientX, e.clientY, node.path, true)
    })

    parentEl.appendChild(itemEl)

    if (!isCollapsed && node.children) {
      node.children.forEach((child) => renderFileNode(child, parentEl, depth + 1))
    }
  } else {
    const icon = document.createElement("span")
    icon.className = "icon"

    const ext = extname(node.name)
    if (ext === ".lua") icon.textContent = "📜"
    else if (ext === ".json") icon.textContent = "⚙️"
    else if (ext === ".scene") icon.textContent = "🎬"
    else icon.textContent = "📄"

    itemEl.appendChild(icon)

    const name = document.createElement("span")
    name.textContent = node.name
    itemEl.appendChild(name)

    itemEl.addEventListener("click", () => {
      if (ext === ".scene") {
        loadSceneFile(node.path)
      } else if (ext === ".lua" || ext === ".json" || ext === ".txt") {
        openScriptTab(node.path)
      }
    })

    parentEl.appendChild(itemEl)
  }
}

async function loadSceneFile(scenePath: string): Promise<void> {
  if (!window.engine.isConnected()) {
    alert("Please connect to the engine first")
    return
  }

  try {
    const sceneJson = await window.project.readTextFile(scenePath)
    console.log("Loading scene JSON:", sceneJson) // DEBUG

    await window.engine.loadScene(sceneJson)

    // Try getting current scene
    const sceneData = await window.engine.getCurrentScene()
    console.log("Current scene data after load:", sceneData) // DEBUG

    await refreshSceneState()
    console.log("Scene loaded:", scenePath)
  } catch (e) {
    console.error("Failed to load scene:", e)
    alert("Failed to load scene: " + e)
  }
}

// ==================== Context Menu ====================
const contextMenu = document.createElement("div")
contextMenu.id = "context-menu"
contextMenu.style.cssText = `
  position: fixed;
  background: #2d2d2d;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 4px 0;
  min-width: 150px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  z-index: 10000;
  display: none;
`
document.body.appendChild(contextMenu)

function showContextMenu(x: number, y: number, path: string, isDirectory: boolean): void {
  contextMenuPath = path

  contextMenu.innerHTML = ""

  if (isDirectory) {
    addContextMenuItem("New Scene", async () => {
      await createNewScene(path)
    })
    addContextMenuItem("New Script", async () => {
      await createNewScript(path)
    })
  }

  contextMenu.style.left = `${x}px`
  contextMenu.style.top = `${y}px`
  contextMenu.style.display = "block"
}

function addContextMenuItem(label: string, onClick: () => void): void {
  const item = document.createElement("div")
  item.textContent = label
  item.style.cssText = `
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    color: #ccc;
  `
  item.addEventListener("mouseenter", () => {
    item.style.background = "#094771"
  })
  item.addEventListener("mouseleave", () => {
    item.style.background = "transparent"
  })
  item.addEventListener("click", () => {
    hideContextMenu()
    onClick()
  })
  contextMenu.appendChild(item)
}

function hideContextMenu(): void {
  contextMenu.style.display = "none"
}

document.addEventListener("click", hideContextMenu)
document.addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement).closest(".file-item")) {
    hideContextMenu()
  }
})

async function createNewScene(dirPath: string): Promise<void> {
  if (!window.engine.isConnected()) {
    alert("Please connect to the engine first")
    return
  }

  const name = await promptModal("New Scene", "Untitled Scene")
  if (!name) return

  // Determine target directory (scenes folder inside assets)
  let targetDir = dirPath
  if (basename(dirPath) !== "scenes") {
    targetDir = join(dirPath, "scenes")
  }

  // Use the name from the JSON response instead of the prompt
  try {
    // Create scene and get the JSON
    const sceneData = await window.engine.createScene(name)

    // Parse to get the actual scene name from JSON
    const sceneJson = JSON.parse(sceneData.sceneJson)
    const sceneName = sceneJson.name || name

    const scenePath = join(targetDir, sceneName + ".scene")

    // Write the scene JSON to file
    await window.project.createDirectory(targetDir)
    await window.project.writeTextFile(scenePath, sceneData.sceneJson)

    await refreshFileTree()
    await refreshSceneState()
    console.log("Scene created:", scenePath)
  } catch (e) {
    console.error("Failed to create scene:", e)
    alert("Failed to create scene: " + e)
  }
}

async function createNewScript(dirPath: string): Promise<void> {
  if (!window.engine.isConnected()) {
    alert("Please connect to the engine first")
    return
  }

  const name = await promptModal("New Script", "NewScript")
  if (!name) return

  // Determine target directory (scripts folder inside assets)
  let targetDir = dirPath
  if (basename(dirPath) !== "scripts") {
    targetDir = join(dirPath, "scripts")
  }

  const scriptPath = join(targetDir, name + ".lua")

  try {
    await window.project.createDirectory(targetDir)

    // Create empty file first
    await window.project.writeTextFile(scriptPath, "")

    // Get template from engine
    const scriptTemplate = await window.engine.createScript(name)

    // Write template to file
    await window.project.writeTextFile(scriptPath, scriptTemplate)

    // Trigger asset rescan on server
    // The ResourceLoader will detect the new file and generate metadata
    await window.engine.rescanAssets() // Add this command

    await refreshFileTree()
    await openScriptTab(scriptPath)
    console.log("Script created:", scriptPath)
  } catch (e) {
    console.error("Failed to create script:", e)

    // Clean up the empty file if it was created (deleting a missing file is not an error)
    try {
      await window.project.deleteFile(scriptPath)
    } catch (cleanupError) {
      console.error("Failed to clean up file:", cleanupError)
    }

    alert("Failed to create script: " + e)
  }
}

// ==================== Script Editor ====================
const bottomPanel = document.getElementById("bottom-panel")!
const scriptTabs = document.getElementById("script-tabs")!
const scriptEditor = document.getElementById("script-editor") as HTMLTextAreaElement

async function openScriptTab(filePath: string): Promise<void> {
  let content: string
  try {
    content = await window.project.readTextFile(filePath)
  } catch (e) {
    console.error("Failed to open file:", e)
    alert("Failed to open file: " + e)
    return
  }
  openScriptTabs.set(filePath, content)
  activeScriptTab = filePath

  bottomPanel.classList.remove("hidden")
  renderScriptTabs()
  scriptEditor.value = content
}

function renderScriptTabs(): void {
  // Built as elements with text content: file names come from disk and are never parsed as HTML
  scriptTabs.replaceChildren()
  for (const path of openScriptTabs.keys()) {
    const tab = document.createElement("div")
    tab.className = path === activeScriptTab ? "tab active" : "tab"
    tab.title = path

    const name = document.createElement("span")
    name.textContent = basename(path)
    tab.appendChild(name)

    const closeBtn = document.createElement("span")
    closeBtn.className = "close"
    closeBtn.textContent = "×"
    tab.appendChild(closeBtn)

    tab.addEventListener("click", () => {
      activeScriptTab = path
      renderScriptTabs()
      scriptEditor.value = openScriptTabs.get(path) || ""
    })

    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      openScriptTabs.delete(path)

      if (activeScriptTab === path) {
        activeScriptTab = openScriptTabs.keys().next().value || null
      }

      if (openScriptTabs.size === 0) {
        bottomPanel.classList.add("hidden")
      }

      renderScriptTabs()
      if (activeScriptTab) {
        scriptEditor.value = openScriptTabs.get(activeScriptTab) || ""
      } else {
        scriptEditor.value = ""
      }
    })

    scriptTabs.appendChild(tab)
  }
}

scriptEditor.addEventListener("input", () => {
  if (activeScriptTab) {
    openScriptTabs.set(activeScriptTab, scriptEditor.value)
  }
})

scriptEditor.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault()
    if (activeScriptTab) {
      const path = activeScriptTab
      window.project.writeTextFile(path, scriptEditor.value).then(
        () => console.log("Saved:", path),
        (err) => {
          console.error("Failed to save:", err)
          alert("Failed to save: " + err)
        }
      )
    }
  }
})

// ==================== Viewport ====================
const canvas = document.getElementById("viewport") as HTMLCanvasElement
const ctx = canvas.getContext("2d")!

let renderLoopId: number | null = null
let renderLoopRunning = false
// Bumped by every start and stop: a loop whose generation is stale ends at its next check, including one that
// was awaiting a frame when it was stopped, so a quick stop and start never leaves two loops running
let renderGeneration = 0

function startRenderLoop(): void {
  if (renderLoopRunning) return
  renderLoopRunning = true
  const generation = ++renderGeneration

  async function render(): Promise<void> {
    renderLoopId = null
    if (generation !== renderGeneration) return
    if (!window.engine.isConnected()) {
      stopRenderLoop()
      return
    }

    try {
      const frame = await window.engine.renderFrame()
      if (generation !== renderGeneration) return

      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width
        canvas.height = frame.height
        showCanvasAtDevicePixels()
      }

      // A view of the received pixels, not a copy (they arrive in a plain ArrayBuffer, never a shared one)
      const { buffer, byteOffset, byteLength } = frame.pixels
      const pixels = new Uint8ClampedArray(buffer as ArrayBuffer, byteOffset, byteLength)
      ctx.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0)
    } catch (e) {
      if (generation === renderGeneration) {
        console.error("Render error:", e)
        stopRenderLoop()
      }
      return
    }

    renderLoopId = requestAnimationFrame(render)
  }

  render()
}

function stopRenderLoop(): void {
  renderLoopRunning = false
  renderGeneration++
  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId)
    renderLoopId = null
  }
}

// The engine renders at the viewport container's size in device pixels, and the canvas shows each frame 1:1: its
// drawing buffer is the frame's size and its CSS size is that divided by devicePixelRatio. The canvas is positioned
// absolutely, so its size never feeds back into the layout; while a resize is pending, a stale frame is shown
// unscaled (cropped or bordered) rather than stretched.
const viewportContainer = document.getElementById("viewport-container")!
/** After the container stops changing size for this long, the new size is sent (on the next animation frame) */
const ViewportSettleMilliseconds = 100

let sentViewportSize: PixelSize | null = null
let viewportSettleTimer: number | null = null

/** Sizes and centres the canvas so one frame pixel is one device pixel */
function showCanvasAtDevicePixels(): void {
  const ratio = window.devicePixelRatio || 1
  const css = cssSizeForPixels({ width: canvas.width, height: canvas.height }, ratio)
  const container = viewportContainer.getBoundingClientRect()
  canvas.style.width = `${css.width}px`
  canvas.style.height = `${css.height}px`
  // Offsets rounded to whole device pixels, so the frame isn't resampled by a half-pixel shift
  canvas.style.left = `${Math.round(((container.width - css.width) / 2) * ratio) / ratio}px`
  canvas.style.top = `${Math.round(((container.height - css.height) / 2) * ratio) / ratio}px`
}

/** Sends the container's device-pixel size to the engine, if it changed (or always, when forced) */
function syncViewportSize(force: boolean = false): void {
  if (!window.engine.isConnected()) {
    sentViewportSize = null
    return
  }
  const rect = viewportContainer.getBoundingClientRect()
  const size = viewportPixelSize(rect.width, rect.height, window.devicePixelRatio)
  if (!size) return // hidden
  if (!force && sentViewportSize?.width === size.width && sentViewportSize?.height === size.height) return

  sentViewportSize = size
  window.engine.setViewportSize(size.width, size.height).catch((e) => {
    console.error("Failed to set viewport size:", e)
    sentViewportSize = null
  })
}

function scheduleViewportSync(): void {
  if (viewportSettleTimer !== null) window.clearTimeout(viewportSettleTimer)
  viewportSettleTimer = window.setTimeout(() => {
    viewportSettleTimer = null
    requestAnimationFrame(() => syncViewportSize())
  }, ViewportSettleMilliseconds)
}

new ResizeObserver(() => {
  showCanvasAtDevicePixels()
  scheduleViewportSync()
}).observe(viewportContainer)

/** devicePixelRatio changes when the window moves to a monitor with another scale, or the page zoom changes */
function watchDevicePixelRatio(): void {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    "change",
    () => {
      showCanvasAtDevicePixels()
      scheduleViewportSync()
      watchDevicePixelRatio()
    },
    { once: true }
  )
}

showCanvasAtDevicePixels()
watchDevicePixelRatio()

// ==================== Hierarchy ====================
const hierarchyEl = document.getElementById("hierarchy")!
const inspectorEl = document.getElementById("inspector")!
const createEntityBtn = document.getElementById("createEntityBtn") as HTMLButtonElement

async function refreshHierarchy(): Promise<void> {
  if (!window.engine.isConnected()) {
    hierarchyEl.innerHTML = '<p style="color: #666; padding: 10px;">Not connected</p>'
    return
  }

  if (!currentScene) {
    hierarchyEl.innerHTML = '<p style="color: #666; padding: 10px;">No scene loaded</p>'
    return
  }

  try {
    entities = await window.engine.getAllEntities()
    renderHierarchy()
  } catch (e) {
    console.error("Failed to get entities:", e)
  }
}

function renderHierarchy(): void {
  if (!currentScene) {
    hierarchyEl.innerHTML = '<p style="color: #666; padding: 10px;">No scene loaded</p>'
    return
  }

  if (entities.length === 0) {
    hierarchyEl.innerHTML = '<p style="color: #666; padding: 10px;">No entities in scene</p>'
    return
  }

  hierarchyEl.innerHTML = entities
    .map(
      (entity) => `
    <div class="hierarchy-item ${entity.id === selectedEntityId ? "selected" : ""}" 
         data-id="${entity.id}">
      🎮 ${entity.name}
    </div>
  `
    )
    .join("")

  hierarchyEl.querySelectorAll(".hierarchy-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = (el as HTMLElement).dataset.id!
      selectEntity(id)
    })
  })
}

async function selectEntity(entityId: string): Promise<void> {
  selectedEntityId = entityId
  renderHierarchy()
  await refreshInspector()
}

createEntityBtn.addEventListener("click", async () => {
  if (!window.engine.isConnected() || !currentScene) {
    alert("Please load a scene first")
    return
  }

  const name = await promptModal("Entity Name", "New Entity")
  if (!name) return

  try {
    const id = await window.engine.createEntity(name)

    if (!id || id === "") {
      console.error("Failed to create entity - server returned empty ID")
      alert("Failed to create entity. Make sure a scene is loaded.")
      return
    }

    await refreshHierarchy()
    await selectEntity(id)
  } catch (e) {
    console.error("Failed to create entity:", e)
    alert("Failed to create entity: " + e)
  }
})

// ==================== Inspector ====================
async function refreshInspector(): Promise<void> {
  if (!selectedEntityId || !window.engine.isConnected()) {
    inspectorEl.innerHTML = '<p style="color: #666; padding: 10px;">Select an entity to inspect</p>'
    return
  }

  try {
    const transform = await window.engine.getEntityTransform(selectedEntityId)
    const entity = entities.find((e) => e.id === selectedEntityId)

    inspectorEl.innerHTML = `
      <div class="inspector-section">
        <h4>Entity</h4>
        <div class="inspector-row">
          <label>Name</label>
          <input type="text" id="entity-name" value="${entity?.name || ""}" />
        </div>
      </div>

      <div class="inspector-section">
        <h4>Transform</h4>
        <div class="inspector-row">
          <label>Position</label>
          <div class="vector-inputs">
            <input type="number" id="pos-x" value="${transform.position.x.toFixed(2)}" step="0.1" />
            <input type="number" id="pos-y" value="${transform.position.y.toFixed(2)}" step="0.1" />
            <input type="number" id="pos-z" value="${transform.position.z.toFixed(2)}" step="0.1" />
          </div>
        </div>
        <div class="inspector-row">
          <label>Rotation</label>
          <div class="vector-inputs">
            <input type="number" id="rot-x" value="${transform.rotation.x.toFixed(2)}" step="1" />
            <input type="number" id="rot-y" value="${transform.rotation.y.toFixed(2)}" step="1" />
            <input type="number" id="rot-z" value="${transform.rotation.z.toFixed(2)}" step="1" />
          </div>
        </div>
        <div class="inspector-row">
          <label>Scale</label>
          <div class="vector-inputs">
            <input type="number" id="scale-x" value="${transform.scale.x.toFixed(2)}" step="0.1" />
            <input type="number" id="scale-y" value="${transform.scale.y.toFixed(2)}" step="0.1" />
            <input type="number" id="scale-z" value="${transform.scale.z.toFixed(2)}" step="0.1" />
          </div>
        </div>
      </div>

      <button id="delete-entity-btn" style="background:#d32f2f;color:#fff;border:none;padding:6px 12px;cursor:pointer;border-radius:3px;margin-top:8px;width:100%;">Delete Entity</button>
    `

    const inputs = ["pos-x", "pos-y", "pos-z", "rot-x", "rot-y", "rot-z", "scale-x", "scale-y", "scale-z"]
    inputs.forEach((id) => {
      const input = document.getElementById(id) as HTMLInputElement
      input.addEventListener("change", updateTransform)
    })

    document.getElementById("delete-entity-btn")?.addEventListener("click", async () => {
      if (!selectedEntityId) return

      try {
        await window.engine.destroyEntity(selectedEntityId)
        selectedEntityId = null
        await refreshHierarchy()
        refreshInspector()
      } catch (e) {
        console.error("Failed to delete entity:", e)
      }
    })
  } catch (e) {
    console.error("Failed to get entity transform:", e)
    inspectorEl.innerHTML = '<p style="color: #f44336; padding: 10px;">Failed to load inspector</p>'
  }
}

async function updateTransform(): Promise<void> {
  if (!selectedEntityId) return

  const posX = parseFloat((document.getElementById("pos-x") as HTMLInputElement).value)
  const posY = parseFloat((document.getElementById("pos-y") as HTMLInputElement).value)
  const posZ = parseFloat((document.getElementById("pos-z") as HTMLInputElement).value)
  const rotX = parseFloat((document.getElementById("rot-x") as HTMLInputElement).value)
  const rotY = parseFloat((document.getElementById("rot-y") as HTMLInputElement).value)
  const rotZ = parseFloat((document.getElementById("rot-z") as HTMLInputElement).value)
  const scaleX = parseFloat((document.getElementById("scale-x") as HTMLInputElement).value)
  const scaleY = parseFloat((document.getElementById("scale-y") as HTMLInputElement).value)
  const scaleZ = parseFloat((document.getElementById("scale-z") as HTMLInputElement).value)

  try {
    await window.engine.setEntityTransform(
      selectedEntityId,
      { x: posX, y: posY, z: posZ },
      { x: rotX, y: rotY, z: rotZ },
      { x: scaleX, y: scaleY, z: scaleZ }
    )
  } catch (e) {
    console.error("Failed to update transform:", e)
  }
}

// ==================== Modal ====================
function promptModal(title: string, defaultValue: string = "New Entity"): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.getElementById("modal-overlay")!
    const input = document.getElementById("modal-input") as HTMLInputElement
    const okBtn = document.getElementById("modal-ok")!
    const cancelBtn = document.getElementById("modal-cancel")!
    const labelEl = overlay.querySelector("label")!

    labelEl.textContent = title + ": "
    labelEl.appendChild(input)

    input.value = defaultValue
    overlay.style.display = "block"
    input.focus()
    input.select()

    function close(value: string | null): void {
      overlay.style.display = "none"
      okBtn.removeEventListener("click", onOk)
      cancelBtn.removeEventListener("click", onCancel)
      input.removeEventListener("keydown", onKeyDown)
      resolve(value)
    }

    function onOk(): void {
      close(input.value.trim() || null)
    }

    function onCancel(): void {
      close(null)
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Enter") onOk()
      if (e.key === "Escape") onCancel()
    }

    okBtn.addEventListener("click", onOk)
    cancelBtn.addEventListener("click", onCancel)
    input.addEventListener("keydown", onKeyDown)
  })
}

// ==================== Resizable Panes ====================
function makeResizable(): void {
  const leftPanel = document.querySelector(".left-panel") as HTMLElement
  const rightPanel = document.querySelector(".right-panel") as HTMLElement
  const bottomPanel = document.getElementById("bottom-panel") as HTMLElement

  createResizer(leftPanel, "right", (delta) => {
    const newWidth = Math.max(150, Math.min(500, leftPanel.offsetWidth + delta))
    leftPanel.style.width = `${newWidth}px`
  })

  createResizer(rightPanel, "left", (delta) => {
    const newWidth = Math.max(200, Math.min(600, rightPanel.offsetWidth - delta))
    rightPanel.style.width = `${newWidth}px`
  })

  createResizer(bottomPanel, "top", (delta) => {
    const newHeight = Math.max(100, Math.min(600, bottomPanel.offsetHeight - delta))
    bottomPanel.style.height = `${newHeight}px`
  })
}

function createResizer(panel: HTMLElement, side: "left" | "right" | "top", onResize: (delta: number) => void): void {
  const resizer = document.createElement("div")
  resizer.style.position = "absolute"
  resizer.style.background = "transparent"
  resizer.style.zIndex = "10"
  resizer.style.cursor = side === "top" ? "ns-resize" : "ew-resize"

  if (side === "left") {
    resizer.style.left = "0"
    resizer.style.top = "0"
    resizer.style.width = "4px"
    resizer.style.height = "100%"
  } else if (side === "right") {
    resizer.style.right = "0"
    resizer.style.top = "0"
    resizer.style.width = "4px"
    resizer.style.height = "100%"
  } else if (side === "top") {
    resizer.style.left = "0"
    resizer.style.top = "0"
    resizer.style.width = "100%"
    resizer.style.height = "4px"
  }

  resizer.addEventListener("mouseenter", () => {
    resizer.style.background = "#0078d4"
  })

  resizer.addEventListener("mouseleave", () => {
    resizer.style.background = "transparent"
  })

  panel.style.position = "relative"
  panel.appendChild(resizer)

  let startPos = 0
  let isDragging = false

  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault()
    isDragging = true
    startPos = side === "top" ? e.clientY : e.clientX
    document.body.style.cursor = side === "top" ? "ns-resize" : "ew-resize"
    document.body.style.userSelect = "none"

    function onMouseMove(e: MouseEvent): void {
      if (!isDragging) return

      const currentPos = side === "top" ? e.clientY : e.clientX
      const delta = currentPos - startPos
      onResize(delta)
      startPos = currentPos
    }

    function onMouseUp(): void {
      isDragging = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
    }

    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  })
}

makeResizable()
