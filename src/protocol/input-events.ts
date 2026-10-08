// SendInput's events (protocol 1.10.0): the shapes the editor sends, and the check the main process makes of what the
// page hands it before it reaches the play child. The engine checks names itself (an unknown key or button refuses the
// whole batch); this only makes sure the page sends plain events of the declared shapes, never anything else.
import type { InputEvent } from "./protocol.generated"
import { MaxInputEventsPerBatch } from "../shared/api"

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/** An engine enum name: letters and digits ("W", "LeftShift", "Key1", "Button4") */
const isName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 32 && /^[A-Za-z0-9]+$/.test(value)

/** One event as a fresh plain object, or an error naming what is wrong with it */
export function checkInputEvent(value: unknown, where: string): InputEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`)
  const event = value as Record<string, unknown>
  switch (event.type) {
    case "key":
      if (!isName(event.key)) throw new Error(`${where}.key must be a key name`)
      if (typeof event.down !== "boolean") throw new Error(`${where}.down must be a boolean`)
      return { type: "key", key: event.key, down: event.down }
    case "mouseButton":
      if (!isName(event.button)) throw new Error(`${where}.button must be a button name`)
      if (typeof event.down !== "boolean") throw new Error(`${where}.down must be a boolean`)
      return { type: "mouseButton", button: event.button, down: event.down }
    case "pointer":
    case "scroll":
      if (!isFiniteNumber(event.x) || !isFiniteNumber(event.y)) throw new Error(`${where} needs a finite x and y`)
      return { type: event.type, x: event.x, y: event.y }
    case "releaseAll":
      return { type: "releaseAll" }
    default:
      throw new Error(`${where}.type must be key, mouseButton, pointer, scroll or releaseAll`)
  }
}

/** The events as a fresh array of fresh events (at most MaxInputEventsPerBatch), or an error */
export function checkInputEvents(value: unknown, where: string): InputEvent[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array of input events`)
  if (value.length > MaxInputEventsPerBatch) {
    throw new Error(`${where} has ${value.length} events; at most ${MaxInputEventsPerBatch} per batch`)
  }
  // An index loop: every and map skip the holes of a sparse array
  const events: InputEvent[] = []
  for (let i = 0; i < value.length; i++) events.push(checkInputEvent(value[i] as unknown, `${where}[${i}]`))
  return events
}
