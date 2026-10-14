// The user name sent in Hello (protocol 1.12): which entry of the host's tokens file the token belongs to. Not secret,
// so it is remembered with the other remote settings. The characters are the ones N2EditorHost --new-token accepts.
// Node only, so it is unit tested.

export const MaxEditorUserLength = 64

const EditorUserPattern = /^[A-Za-z0-9._@-]+$/

/** Why this isn't a user name the host's tokens file can hold, or null */
export function editorUserProblem(user: string): string | null {
  if (user.length > MaxEditorUserLength) return `The user name is too long (at most ${MaxEditorUserLength} characters)`
  if (!EditorUserPattern.test(user)) return "The user name can only have letters, digits and . _ @ -"
  return null
}

/**
 * The optional user from a settings object: undefined for none (absent, null or blank), the trimmed name, or an Error
 * saying what is wrong
 */
export function parseEditorUser(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new Error("The user name must be text")
  const user = value.trim()
  if (user === "") return undefined
  const problem = editorUserProblem(user)
  if (problem) throw new Error(problem)
  return user
}
