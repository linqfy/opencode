export const scheduleMemoryTurn = (work: () => Promise<void>): void => {
  queueMicrotask(() => {
    void Promise.resolve().then(work).catch(() => undefined)
  })
}
