// The bridge's budgets (design M1). Every result the model sees is bounded by these; nothing here is a security
// boundary (the host's role gate is), they keep a big project from flooding the agent's context.

/** The most a result's whole text block may be (summary, envelope and data): a guard, never reached by a tool that keeps its own budget */
export const MaxResultBytes = 128 * 1024

/** What the data of a list-like result (hierarchy, assets, console) is kept under, as JSON: bytes of UTF-8 */
export const PageBytes = 96 * 1024

/** The hierarchy's page: nodes */
export const HierarchyDefaultLimit = 200
export const HierarchyMaxLimit = 2000

/** The asset list's page: entries (folders and assets) */
export const AssetsDefaultLimit = 200
export const AssetsMaxLimit = 2000

/** A text asset: bytes per result, by default and at most */
export const TextAssetDefaultBytes = 32 * 1024
export const TextAssetMaxBytes = 100 * 1024

/** Console lines per call, by default and at most, and the length of one line */
export const ConsoleDefaultLines = 100
export const ConsoleMaxLines = 1000
export const ConsoleLineChars = 1024

/** An entity's component values and other free-form JSON from the project: bytes of UTF-8 */
export const EntityValuesBytes = 64 * 1024
export const SmallJsonBytes = 16 * 1024

/** A name (entity, asset path, tag) in a result */
export const NameChars = 256
/** Any other string in a result */
export const StringChars = 4096

/** Screenshots: the default size, the longest side allowed, the host's own limit, and the PNG's size */
export const ScreenshotDefaultWidth = 768
export const ScreenshotDefaultHeight = 432
export const ScreenshotMaxSide = 1568
export const ScreenshotMaxPngBytes = 3 * 1024 * 1024

/** Tool calls per minute (design 4.5) */
export const RateLimitPerMinute = 120

/** How long one tool call may wait for the host before the connection is dropped (a hung host) */
export const DefaultCallTimeoutMs = 60000

/** How long a call waits before its one retry when the host is busy */
export const DefaultBusyWaitMs = 3000
export const MaxBusyWaitMs = 10000

// ===== write budgets (design M1, 4.5) =====

/** Host write commands per agent session (an implicit or begun one) */
export const MaxWritesPerSession = 2000
/** Ops in one n2_apply_batch */
export const MaxBatchOps = 500
/** A text asset written through n2_write_text_asset or n2_create_script: bytes of UTF-8 */
export const WriteTextMaxBytes = 100 * 1024
/** Text asset writes per session */
export const MaxTextWritesPerSession = 200
/** A file this large or larger is not overwritten (its previous content must be kept as a backup): bytes */
export const BackupMaxFileBytes = 512 * 1024
/** All backups of one session together: bytes */
export const BackupMaxSessionBytes = 16 * 1024 * 1024
/** Sessions the bridge keeps at once, and how long one may sit idle before it is dropped */
export const MaxSessions = 16
export const SessionIdleMs = 24 * 60 * 60 * 1000
/** Journal entries kept per session (the oldest are summarised away past this) */
export const MaxJournalEntries = 4000
/** How many own steps n2_undo / n2_redo / the batch tools may move in one call */
export const MaxUndoSteps = 20
/** Edit group labels are cut to this many bytes by the host */
export const EditLabelBytes = 100

// ===== play budgets (design 4.5, MCP3) =====

/** Frames one n2_play_control step or one n2_play_script step op may run (the host takes up to 1000 per Step) */
export const MaxStepFramesPerCall = 600
/** A step runs as Step commands of at most this many frames, with progress and a cancellation check between them */
export const StepChunkFrames = 100
/** Game frames one agent session may step */
export const MaxPlayFramesPerSession = 20000
/** Play screenshots (n2_play_observe and n2_play_script) one agent session may take */
export const MaxPlayScreenshotsPerSession = 50
/** Input events in one n2_play_input call or one script input op */
export const MaxInputEventsPerCall = 256
/** Ops in one n2_play_script, its screenshots, its frames in all, and the long side of its pictures */
export const MaxScriptOps = 50
export const MaxScriptScreenshots = 4
export const MaxScriptFrames = 3000
export const ScriptScreenshotMaxSide = 1024
/** All the PNGs of one result together: bytes */
export const MaxResultPngBytes = 6 * 1024 * 1024
/** Entities n2_play_observe reads from the game in one call */
export const MaxObservedEntities = 8
/** Log lines n2_play_observe returns, by default and at most */
export const ObserveDefaultLines = 50
export const ObserveMaxLines = 200

// ===== resources and subscriptions (design 3.6, MCP3) =====

/** Resource URIs watched at once (resources/subscribe and subscriptions/listen together); more are refused */
export const MaxWatchedUris = 32
/** subscriptions/listen streams one connection may hold open */
export const MaxListenSubscriptions = 8
/** How often the host's events are polled while something is watched, and after a failed poll */
export const WatchPollMs = 500
export const WatchRetryMs = 5000
/** n2://console is announced at most this often (design: debounced 1 s) */
export const ConsoleDebounceMs = 1000
/** Lines n2://console holds */
export const ConsoleResourceLines = 200
