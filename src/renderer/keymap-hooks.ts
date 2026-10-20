// Registers a component's keyboard actions with the page's keymap for as long as it is mounted. The handlers may close
// over the component's current state: the latest ones run (the registration is made once).
import { useEffect, useRef } from "preact/hooks"
import type { RefObject } from "preact"
import { ActionHandler, keymap } from "./keymap"

export type ActionHandlers = Readonly<Record<string, ActionHandler>>

/**
 * Registers handlers for the named actions. `within`: the element the key presses must be in (read when the component
 * has mounted), for an action the component has an instance of per panel; omitted, any key press runs it.
 */
export function useKeymapActions(handlers: ActionHandlers, within?: RefObject<Element | null>): void {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    const element = within?.current ?? null
    // Asked to be limited to an element that isn't there: registering for any key press would be wrong
    if (within && element === null) return
    const unregister = Object.keys(handlers).map((id) =>
      keymap.handle(id, (e) => latest.current[id]?.(e), { within: element })
    )
    return () => unregister.forEach((off) => off())
  }, [])
}
