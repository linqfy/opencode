// Memory aging: staleness hints (ported from Claude Code's memdir/memoryAge.ts).
// Pure functions. Aging is a hint surfaced to the model; memories are never
// auto-dropped by age.

export const memoryAgeDays = (mtimeMs: number): number =>
  Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000))

export const memoryAge = (mtimeMs: number): string => {
  const days = memoryAgeDays(mtimeMs)
  if (days === 0) return "today"
  if (days === 1) return "yesterday"
  return `${days} days ago`
}

export const memoryFreshnessText = (mtimeMs: number): string => {
  const days = memoryAgeDays(mtimeMs)
  if (days <= 1) return ""
  return (
    `This memory is ${days} days old. ` +
    "Memories are point-in-time observations, not live state — " +
    "claims about code behavior or file:line citations may be outdated. " +
    "Verify against current code before asserting as fact."
  )
}

export const memoryFreshnessNote = (mtimeMs: number): string => {
  const text = memoryFreshnessText(mtimeMs)
  return text ? `<system-reminder>${text}</system-reminder>\n` : ""
}
