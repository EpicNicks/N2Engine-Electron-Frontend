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
