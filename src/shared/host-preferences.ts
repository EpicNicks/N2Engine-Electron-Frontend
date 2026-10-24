import type { HostLaunchPreferences } from "./api"

export const ReadyTimeoutLimits = { min: 1000, max: 300000 }

/** Validate the same small allowlist in the page and again at the IPC boundary. */
export function parseHostLaunchPreferences(raw: unknown): HostLaunchPreferences {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid host preferences")
  const value = raw as Record<string, unknown>
  if (typeof value.hostPath !== "string" || value.hostPath.length > 4096 || /[\x00-\x1f]/.test(value.hostPath))
    throw new Error("Host executable must be a path of at most 4096 characters")
  if (value.renderer !== "" && value.renderer !== "opengl" && value.renderer !== "software")
    throw new Error("Choose Default, OpenGL, or Software for the renderer")
  if (!Number.isInteger(value.readyTimeoutMs) || (value.readyTimeoutMs as number) < ReadyTimeoutLimits.min ||
      (value.readyTimeoutMs as number) > ReadyTimeoutLimits.max)
    throw new Error("Startup timeout must be between 1 and 300 seconds (whole milliseconds)")
  return { hostPath: value.hostPath.trim(), renderer: value.renderer, readyTimeoutMs: value.readyTimeoutMs as number }
}
