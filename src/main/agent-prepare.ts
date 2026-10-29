// The main process asks the page to settle before an agent's call (MCP6): the page sends the inspector's pending edits, ends
// its edit groups and finishes the drags and renames that are running (the same sequence Undo and an extension's menu item
// run first, edit-controller.ts), and answers. Node only (no Electron): the sending is a function, so it is unit tested.
export class PrepareChannel {
  private nextId = 1
  private readonly waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  /**
   * send posts the request to the page and says whether there was a page to post it to. A page that does not answer in
   * timeoutMs fails the request: the agent's call is refused, never run unsettled.
   */
  constructor(
    private readonly send: (id: number) => boolean,
    private readonly timeoutMs: number = 10000
  ) {}

  request(): Promise<void> {
    const id = this.nextId++
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error("the editor window did not settle in time"))
      }, this.timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      if (!this.send(id)) {
        clearTimeout(timer)
        this.waiting.delete(id)
        reject(new Error("the editor window is not open"))
      }
    })
  }

  /** The page's answer; error is null when it settled */
  answer(id: unknown, error: unknown): void {
    if (typeof id !== "number") return
    const entry = this.waiting.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.waiting.delete(id)
    if (error === null || error === undefined) entry.resolve()
    else entry.reject(new Error(typeof error === "string" ? error : "the page failed to settle"))
  }

  /** The page went away: every request fails */
  cancelAll(reason = "the editor window went away"): void {
    for (const [id, entry] of this.waiting) {
      clearTimeout(entry.timer)
      this.waiting.delete(id)
      entry.reject(new Error(reason))
    }
  }
}
