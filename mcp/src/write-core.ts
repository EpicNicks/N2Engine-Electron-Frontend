// The machinery every write tool shares (MCP2): one undo step per call, rolled back on failure, journaled in the agent's
// session, with the host's edit result returned.
//
// A call's host commands run inside ONE edit group labelled "AI: <tool> #<n>" (design 5.1). The group is opened and closed
// inside the call, never held across calls (an open group refuses Undo, and a disconnect closes it). When a command fails
// the group is closed and, if it already made an undo step, that step is undone at once, so a failed call leaves no trace;
// the error says which of the three things happened (nothing applied, rolled back, or unknown).
import { createHash } from "node:crypto"
import { z } from "zod"
import { EngineError } from "../../src/protocol/engine-client"
import type { HistoryResponse } from "../../src/protocol/protocol.generated"
import type { HostContext } from "./bridge"
import { BridgeError, mapError, safeRole } from "./errors"
import { writesAllowed } from "./policy"
import type { FileWrite, JournalEntry, Session } from "./session"
import type { ToolOutput } from "./tools"

export interface Touched {
  created: string[]
  destroyed: string[]
  modified: string[]
}

export const newTouched = (): Touched => ({ created: [], destroyed: [], modified: [] })

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

/** Refuses a write call on a connection that may not write (defence in depth: such tools are not listed, and the host refuses too) */
export function assertWritable(ctx: HostContext): void {
  const access = { role: safeRole(ctx.info.role), readOnly: ctx.info.readOnly }
  if (writesAllowed(access, ctx.allowAdmin)) return
  if (ctx.info.readOnly) {
    throw new BridgeError(
      "read_only",
      "The host runs read-only, so nothing can be changed.",
      "Only the inspection tools work. Do not retry."
    )
  }
  throw new BridgeError(
    "forbidden",
    `The token's role (${safeRole(ctx.info.role)}) may not change the project.`,
    "Inspection tools still work. Changing the project needs an editor token: ask the operator to start the bridge with one. Do not retry."
  )
}

/** The part of every write result that says what the host did with the edit */
export const editInfoSchema = z.object({
  sessionId: z.string().describe("The agent session the call was journaled in (the implicit one is named implicit)."),
  label: z.string().describe("The undo step's label as the editor's Edit menu shows it (AI: <tool> #<n>); empty when the call made no step."),
  stepAdded: z.boolean().describe("The call made one undo step (every edit tool makes exactly one, however many host commands it ran)."),
  revision: z.number().nullable().describe("The open scene's revision after the call; null when the host could not say."),
  savedRevision: z.number().nullable(),
  dirty: z.boolean().nullable().describe("The open scene has unsaved changes."),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  undoSteps: z.number().describe("Steps in the host's undo history that are done."),
  writesUsed: z.number().describe("Host write commands this session has used."),
  writesMax: z.number(),
})

export type EditInfo = z.infer<typeof editInfoSchema>

async function sceneRevisions(ctx: HostContext): Promise<{ revision: number; savedRevision: number } | null> {
  try {
    const s = await ctx.client.getOpenScene()
    return { revision: s.revision, savedRevision: s.savedRevision }
  } catch (e) {
    if (e instanceof EngineError && e.code === undefined) return null
    if (e instanceof EngineError) return null
    throw e
  }
}

function edit(ctx: HostContext, agent: Session, label: string, stepAdded: boolean, history: HistoryResponse | null, scene: { revision: number; savedRevision: number } | null): EditInfo {
  const summary = agent.summary()
  return {
    sessionId: agent.id,
    label: stepAdded ? ctx.scrubber.name(label, 120) : "",
    stepAdded,
    revision: scene?.revision ?? null,
    savedRevision: scene?.savedRevision ?? null,
    dirty: scene ? scene.revision !== scene.savedRevision : null,
    canUndo: history ? history.cursor > 0 : false,
    canRedo: history ? history.cursor < history.entries.length : false,
    undoSteps: history?.cursor ?? 0,
    writesUsed: summary.writes,
    writesMax: summary.maxWrites,
  }
}

/** The edit info for a call that made no undo step (files, scene file, settings): the history as it is now */
export async function currentEditInfo(ctx: HostContext, agent: Session): Promise<EditInfo> {
  let history: HistoryResponse | null = null
  try {
    history = await ctx.client.getHistory()
  } catch (e) {
    if (!(e instanceof EngineError)) throw e
  }
  return edit(ctx, agent, "", false, history, await sceneRevisions(ctx))
}

/** A failure inside the group, with what became of the group's changes */
class GroupFailure extends Error {
  constructor(
    readonly original: unknown,
    readonly outcome: "none" | "undone" | "unknown" | "undo-failed"
  ) {
    super("group failed")
  }
}

/** Thrown inside a batch's group by the op that failed: which one, and why */
export class BatchOpError extends Error {
  constructor(
    readonly index: number,
    readonly kind: string,
    readonly inner: unknown
  ) {
    super("batch op failed")
  }
}

/** The BridgeError for a failure in a write call, with a sentence about what happened to the call's changes */
export function failureError(ctx: HostContext, tool: string, failure: GroupFailure): BridgeError {
  const failed = failure.original instanceof BatchOpError ? failure.original : null
  const base = mapError(failed ? failed.inner : failure.original, { command: failed ? `${tool}/${failed.kind}` : tool, role: ctx.info.role }, ctx.scrubber)
  const note =
    failure.outcome === "none"
      ? "Nothing was applied."
      : failure.outcome === "undone"
        ? "Nothing was applied: the call's changes were undone as one step."
        : failure.outcome === "undo-failed"
          ? "The call's changes could NOT be undone (the host may have cleared its undo history): call n2_status and n2_get_hierarchy to see what the scene holds, and tell the person."
          : "What the call changed is unknown (the connection to the host failed): call n2_status and n2_get_hierarchy to check, and tell the person."
  if (failed) {
    return new BridgeError("batch_failed", `Op ${failed.index} (${failed.kind}) failed (${base.code}): ${base.message} ${note}`, base.advice, base.hostText, base.cause)
  }
  return new BridgeError(base.code, `${base.message} ${note}`, base.advice, base.hostText, base.cause)
}

export interface GroupResult<T> {
  value: T
  label: string
  stepAdded: boolean
  history: HistoryResponse | null
}

/**
 * Runs body inside one edit group for the agent session: counts `cost` host write commands against the session's
 * budget first (refusing when it would pass it), then begins the group, runs body, ends the group and checks that exactly
 * the group's step is on top of the history. A failure closes the group and undoes its step.
 */
export async function inGroup<T>(ctx: HostContext, agent: Session, tool: string, cost: number, body: () => Promise<T>): Promise<GroupResult<T>> {
  agent.spend(cost)
  const label = ctx.sessions.nextLabel(tool)
  let before: HistoryResponse | null = null
  try {
    before = await ctx.client.getHistory()
    await ctx.client.beginEditGroup(label)
  } catch (e) {
    throw failureError(ctx, tool, new GroupFailure(e, "none"))
  }
  let failure: { error: unknown } | null = null
  let value: T | undefined
  try {
    value = await body()
  } catch (e) {
    failure = { error: e }
  }
  let endError: unknown = null
  try {
    await ctx.client.endEditGroup()
  } catch (e) {
    endError = e
  }
  let after: HistoryResponse | null = null
  try {
    after = await ctx.client.getHistory()
  } catch (e) {
    if (failure === null && endError === null) throw failureError(ctx, tool, new GroupFailure(e, "unknown"))
    failure ??= { error: e }
    if (!(e instanceof EngineError)) throw failureError(ctx, tool, new GroupFailure(failure.error, "unknown"))
  }
  const top = after && after.cursor > 0 ? after.entries[after.cursor - 1].label : null
  // The label is unique in this process, so it on top means the group made its step
  // and a step of an earlier bridge run with the same label does not count: the history must have moved
  const foreignTop = before !== null && after !== null && before.cursor === after.cursor && before.cursor > 0 && before.entries[before.cursor - 1].label === label
  const stepAdded = top === label && !foreignTop
  if (failure === null && endError !== null) failure = { error: endError }
  if (failure !== null) {
    if (after === null) throw failureError(ctx, tool, new GroupFailure(failure.error, "unknown"))
    if (!stepAdded) throw failureError(ctx, tool, new GroupFailure(failure.error, "none"))
    try {
      const undone = await ctx.client.undo()
      if (undone.label !== label) throw new Error("the undo answered another step")
    } catch {
      throw failureError(ctx, tool, new GroupFailure(failure.error, "undo-failed"))
    }
    throw failureError(ctx, tool, new GroupFailure(failure.error, "undone"))
  }
  if (stepAdded) {
    agent.live.push(label)
    // A new edit makes the host drop its redo steps
    agent.undone = []
  }
  return { value: value as T, label, stepAdded, history: after }
}

/** Journals a finished call and builds the shared part of its result */
export async function finishEdit(
  ctx: HostContext,
  agent: Session,
  tool: string,
  summary: string,
  group: GroupResult<unknown>,
  touched: Touched,
  now: () => number = Date.now
): Promise<EditInfo> {
  const s = ctx.scrubber
  agent.record(
    {
      tool,
      summary: s.str(summary, { maxChars: 300 }),
      label: group.stepAdded ? group.label : undefined,
      stepAdded: group.stepAdded,
      created: touched.created.length ? touched.created : undefined,
      destroyed: touched.destroyed.length ? touched.destroyed : undefined,
      modified: touched.modified.length ? touched.modified : undefined,
    },
    now()
  )
  return edit(ctx, agent, group.label, group.stepAdded, group.history, await sceneRevisions(ctx))
}

/** Journals a call that made no undo step (a file, the scene file, the settings) */
export async function finishOther(
  ctx: HostContext,
  agent: Session,
  tool: string,
  summary: string,
  extra: Partial<Omit<JournalEntry, "seq" | "at" | "tool" | "summary" | "stepAdded">> = {},
  now: () => number = Date.now
): Promise<EditInfo> {
  agent.record({ tool, summary: ctx.scrubber.str(summary, { maxChars: 300 }), stepAdded: false, ...extra }, now())
  return currentEditInfo(ctx, agent)
}

export function fileRecord(path: string, created: boolean, text: string, backupId?: string): FileWrite {
  return { path, created, hash: sha256(text), ...(backupId ? { backupId } : {}) }
}

/** The ToolOutput of a write: untrusted because it can echo names and values from the project */
export function writeOutput(summary: string, data: unknown, extra: Partial<ToolOutput> = {}): ToolOutput {
  return { source: "scene", untrusted: true, summary, data, ...extra }
}
