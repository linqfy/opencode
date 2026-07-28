export type TerminalWriterOptions = {
  schedule?: (flush: VoidFunction) => void
  maxPendingBytes?: number
}

// Coalesces terminal output: small bursts merge into the scheduled frame;
// buffering past maxPendingBytes forces an immediate write so large dumps
// never accumulate in memory (spec section 14).
export function terminalWriter(write: (data: string, done?: VoidFunction) => void, options?: TerminalWriterOptions) {
  const schedule = options?.schedule ?? queueMicrotask
  const maxPendingBytes = options?.maxPendingBytes ?? 16 * 1024
  let chunks: string[] | undefined
  let pendingBytes = 0
  let waits: VoidFunction[] | undefined
  let scheduled = false
  let writing = false

  const settle = () => {
    if (scheduled || writing || chunks?.length) return
    const list = waits
    if (!list?.length) return
    waits = undefined
    for (const fn of list) {
      fn()
    }
  }

  const run = () => {
    if (writing) return
    scheduled = false
    const items = chunks
    if (!items?.length) {
      settle()
      return
    }
    chunks = undefined
    pendingBytes = 0
    writing = true
    write(items.join(""), () => {
      writing = false
      if (pendingBytes >= maxPendingBytes) {
        run()
        return
      }
      if (chunks?.length) {
        if (scheduled) return
        scheduled = true
        schedule(run)
        return
      }
      settle()
    })
  }

  const push = (data: string) => {
    if (!data) return
    if (chunks) chunks.push(data)
    else chunks = [data]
    pendingBytes += data.length

    if (writing) return
    if (pendingBytes >= maxPendingBytes) {
      run()
      return
    }
    if (scheduled) return
    scheduled = true
    schedule(run)
  }

  const flush = (done?: VoidFunction) => {
    if (!scheduled && !writing && !chunks?.length) {
      done?.()
      return
    }
    if (done) {
      if (waits) waits.push(done)
      else waits = [done]
    }
    run()
  }

  return { push, flush }
}

export function makeFrameScheduler(frameMs = 16) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (flush: VoidFunction) => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, frameMs)
  }
}
