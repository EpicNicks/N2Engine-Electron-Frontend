/** EN1's compile-only reply. No script is executed by syntax checking. */
export interface LuaSyntaxResult { ok: boolean; line: number; column?: number; message: string }
export type LuaSyntaxChecker = (text: string, chunkName: string) => Promise<LuaSyntaxResult>
export interface SyntaxDiagnostic { from: number; to: number; severity: "error"; message: string }
export interface SyntaxTimers { set(callback: () => void, delay: number): unknown; clear(handle: unknown): void }
const browserTimers: SyntaxTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }

export function syntaxDiagnostic(text: string, result: LuaSyntaxResult): SyntaxDiagnostic[] {
  if (result.ok) return []
  const lines = text.split("\n")
  const row = Math.min(Math.max(1, Math.trunc(result.line) || 1), lines.length) - 1
  let from = lines.slice(0, row).reduce((sum, line) => sum + line.length + 1, 0)
  if (Number.isFinite(result.column) && result.column! > 0) from += Math.min(lines[row].length, Math.trunc(result.column!) - 1)
  const to = Math.min(text.length, result.column ? from + 1 : from + lines[row].length)
  return [{ from, to, severity: "error", message: result.message }]
}

/** A single in-flight request and latest-wins queue. Old replies never mark a newer document or another tab. */
export class LuaSyntaxScheduler {
  private version = 0
  private timer: unknown = null
  private pending: { text: string; chunkName: string; version: number } | null = null
  private inFlight = false
  private disposed = false
  constructor(private readonly check: LuaSyntaxChecker,
    private readonly publish: (diagnostics: SyntaxDiagnostic[], error?: string) => void,
    private readonly timers = browserTimers, private readonly delay = 500) {}
  update(text: string, chunkName: string): void {
    if (this.disposed) return
    this.version++
    this.pending = null
    this.publish([])
    if (this.timer !== null) this.timers.clear(this.timer)
    const version = this.version
    this.timer = this.timers.set(() => { this.timer = null; this.pending = { text, chunkName, version }; void this.send() }, this.delay)
  }
  private async send(): Promise<void> {
    if (this.inFlight || !this.pending || this.disposed) return
    const request = this.pending; this.pending = null; this.inFlight = true
    try {
      const reply = await this.check(request.text, request.chunkName)
      if (!this.disposed && request.version === this.version) this.publish(syntaxDiagnostic(request.text, reply))
    } catch (error) {
      if (!this.disposed && request.version === this.version)
        this.publish([], `Syntax check unavailable: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.inFlight = false
      if (!this.disposed && this.pending) void this.send()
    }
  }
  dispose(): void {
    this.disposed = true; this.version++; this.pending = null
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}
