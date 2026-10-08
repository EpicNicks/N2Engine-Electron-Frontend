// Checks of the entity commands' arguments that the engine would refuse anyway (protocol 1.4.0), made before the
// request is sent so a bad one fails at once with a clear message instead of a round trip. The engine stays the
// authority: a value this lets through (an unknown parent, a zero quaternion) is its Error to answer.

/** The properties SetEntityProperties changes, and no others: the engine refuses a key it doesn't know */
export const EntityPropertyKeys = ["name", "active", "tag", "layer"] as const

/** The highest layer index (layers are 0 to 31) */
export const MaxLayer = 31

/**
 * Throws naming the problem unless properties is a plain object whose keys are name (string), active (boolean),
 * tag (string) and layer (integer, 0 to 31). An empty object is fine (it changes nothing).
 */
export function checkEntityProperties(properties: unknown): void {
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new Error("properties must be a JSON object")
  }
  for (const [key, value] of Object.entries(properties)) {
    switch (key) {
      case "name":
      case "tag":
        if (typeof value !== "string") throw new Error(`property ${key} must be a string`)
        break
      case "active":
        if (typeof value !== "boolean") throw new Error("property active must be a boolean")
        break
      case "layer":
        if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MaxLayer) {
          throw new Error(`property layer must be an integer from 0 to ${MaxLayer}`)
        }
        break
      default:
        throw new Error(`unknown property ${key} (the properties are ${EntityPropertyKeys.join(", ")})`)
    }
  }
}
