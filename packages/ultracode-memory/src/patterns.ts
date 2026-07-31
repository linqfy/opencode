// Shared regex sources for memory citations. Kept separate so the pattern is
// single-sourced and testable.

export const MEMORY_CITATION_PATTERN: RegExp =
  /<memory-citation\s+thread_id="(?<thread_id>[A-Za-z0-9_-]+)"(?:\s+path="(?<path>[^"]+)")?\s*\/>/g
