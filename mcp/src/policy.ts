// The operator's policy for the write tools (design 4.3: flags narrow, never widen). Pure data and two functions: the
// server uses them to decide which tools are listed, and the tools to decide what an irreversible call may do.
import { MaxWritesPerSession } from "./limits"

export interface Policy {
  /** --read-only: no write tool is listed or callable, whatever the host allows */
  readOnly: boolean
  /** --allow-irreversible: an irreversible operation may run without the client's confirmation (the operator's consent) */
  allowIrreversible: boolean
  /** --max-writes: host write commands per agent session */
  maxWrites: number
  /** --write-tools: when set, only these write tools are listed (an enable list); null: all of them */
  writeTools: ReadonlySet<string> | null
  /** --disable-tools: tools that are never listed, read or write */
  disabledTools: ReadonlySet<string>
  /** --keep-journal: the journal folder (backups of overwritten files) is not deleted at exit */
  keepJournal: boolean
}

export const DefaultPolicy: Policy = {
  readOnly: false,
  allowIrreversible: false,
  maxWrites: MaxWritesPerSession,
  writeTools: null,
  disabledTools: new Set(),
  keepJournal: false,
}

/** What the host told this connection: the only things the listing depends on */
export interface HostAccess {
  role: string
  readOnly: boolean
}

/**
 * Whether the write tools may be offered for a host connection: an editor (or an admin the operator allowed) on a host
 * that is not read-only. A viewer, an unknown role and a read-only host get none (the host would refuse them anyway).
 */
export function writesAllowed(access: HostAccess | null, allowAdmin: boolean): boolean {
  if (access === null || access.readOnly) return false
  return access.role === "editor" || (access.role === "admin" && allowAdmin)
}

/** Whether the policy's flags list a tool (before the host's role is considered) */
export function toolListedByPolicy(policy: Policy, name: string, isWrite: boolean): boolean {
  if (policy.disabledTools.has(name)) return false
  if (!isWrite) return true
  if (policy.readOnly) return false
  return policy.writeTools === null || policy.writeTools.has(name)
}
