// The play session's IPC: the page starts, stops, pauses and steps the game, and reaches the running child through
// PlayCommandArgs' commands only (frames, audio, events, input), with arguments of the declared types. The child's
// connection and token never leave the main process, like the edit host's (engine-ipc.ts).
import { IpcMain } from "electron"
import {
  ArgKind,
  Channels,
  PlayCommandArgs,
  PlayCommandName,
  PlayState,
} from "../shared/api"
import { checkArg, ownedViews } from "./engine-ipc"
import { EditorPage, handleResult } from "./ipc"
import type { PlaySession } from "./play-session"

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)

/** The arguments of a forwarded play command, checked against the declared kinds */
export function checkPlayCall(name: unknown, args: unknown): { name: PlayCommandName; args: unknown[] } {
  if (typeof name !== "string" || !hasOwn(PlayCommandArgs, name)) throw new Error(`Unknown play command ${String(name)}`)
  const kinds: readonly ArgKind[] = PlayCommandArgs[name as PlayCommandName]
  if (!Array.isArray(args)) throw new Error(`${name}: arguments must be an array`)
  if (args.length !== kinds.length) throw new Error(`${name} takes ${kinds.length} arguments, got ${args.length}`)
  return { name: name as PlayCommandName, args: kinds.map((kind, i) => checkArg(kind, args[i], `${name} argument ${i + 1}`)) }
}

export function registerPlayIpc(
  ipcMain: IpcMain,
  deps: { page: EditorPage; session: PlaySession }
): void {
  const { page, session } = deps
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void =>
    handleResult(ipcMain, channel, page, handler)

  handle(Channels.playGetState, (): PlayState => session.state)
  // "" is the open scene, as it is in the edit host's memory (unsaved edits included)
  handle(Channels.playStart, () => session.start(""))
  handle(Channels.playStop, () => session.stop())
  handle(Channels.playSetPaused, (paused) => {
    if (typeof paused !== "boolean") throw new Error("setPaused takes a boolean")
    return session.setPaused(paused)
  })
  handle(Channels.playStep, (frames) => {
    if (typeof frames !== "number") throw new Error("step takes a number of frames")
    return session.step(frames)
  })
  handle(Channels.playRefresh, () => session.refresh())
  handle(Channels.playCall, async (name, args) => {
    const call = checkPlayCall(name, args)
    const client = session.client
    const method = client[call.name] as (...a: unknown[]) => Promise<unknown>
    // The result goes over IPC: never as a view onto a larger buffer
    return ownedViews(await method.apply(client, call.args))
  })
}
