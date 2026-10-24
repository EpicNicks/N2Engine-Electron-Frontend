import { signal } from "@preact/signals-core"
export const preferencesRequest = signal<number | null>(null)
let sequence = 0
export function showPreferences(): void { if (preferencesRequest.peek() === null) preferencesRequest.value = ++sequence }
export function closePreferences(): void { preferencesRequest.value = null }
