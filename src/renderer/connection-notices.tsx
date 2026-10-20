// What the editor says about a remote host that is busy with another session, or that closed the session it had.
// Everything the host said is shown as text (never as markup): the store builds these messages from known words.
import { useApp } from "./ui"

/** Seconds, rounded up, for the wait before the next try */
const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000))

/**
 * On the connect screen: the host answered busy (another session holds it), so the editor tries again by itself with
 * a growing delay, until it gives up and offers Retry. Cancel stops it and forgets the connect (and its token).
 * Nothing is shown when the host isn't busy.
 */
export function BusyRetryNotice() {
  const { store } = useApp()
  const state = store.busyRetry.value
  if (state === null) return null
  return (
    <div class="busy-retry" role="status">
      <p>
        {state.message}.{" "}
        {state.phase === "waiting" && `It will try again in ${seconds(state.delayMs)} s (attempt ${state.attempt}).`}
        {state.phase === "trying" && "Trying again..."}
        {state.phase === "gaveUp" && "It stopped trying after about two minutes."}
      </p>
      <div class="busy-retry-actions">
        {state.phase === "gaveUp" && (
          <button type="button" onClick={() => store.retryBusyNow()}>
            Retry
          </button>
        )}
        <button type="button" class="secondary" onClick={() => store.cancelBusyRetry()}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * In the editor: the host closed the connection of a remote session. A host serves one session at a time, closes
 * the old one (without a word) when the same user or a higher role connects, and so does not say why, so this says
 * what it can. The editor does not reconnect by itself: that would take the host back from the other session.
 */
export function ConnectionLostNotice() {
  const { store } = useApp()
  if (!store.remoteConnectionLost.value) return null
  return (
    <div class="connection-lost" role="status">
      <span>
        The host closed the connection. If another client connected as the same user, or with a higher role, it took
        this session over; the editor won't reconnect by itself, so as not to take it back.
      </span>
      <button type="button" onClick={() => store.reconnectRemote()} disabled={store.busy.value !== null}>
        Reconnect
      </button>
    </div>
  )
}
