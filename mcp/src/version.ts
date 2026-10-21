// What the bridge calls itself. serverInfo.version is the bridge's semver: a breaking change to a tool's schema bumps
// the major version and regenerates mcp/tool-schemas.golden.json (design 6.4).
export const BridgeName = "n2-mcp"
export const BridgeVersion = "0.1.0"

/**
 * The MCP spec revisions the pinned SDK (@modelcontextprotocol/server 2.3.1, via serveStdio) serves on one stdio
 * connection: 2026-07-28 (server/discover, per-request protocol version) and the handshake-based 2025-11-25 (and older
 * ones the SDK still accepts), chosen by how the client opens the connection.
 */
export const SupportedSpecRevisions = ["2026-07-28", "2025-11-25"] as const
