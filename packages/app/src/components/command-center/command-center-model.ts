export type CommandCenterTask = {
  task_id: string
  parent_task_id: string | null
  depth: number
  state: string
}

export function pageLimit(value: number | undefined) {
  return Math.min(200, Math.max(1, Math.floor(value ?? 100)))
}

export function flattenTaskGraph(input: { tasks: readonly CommandCenterTask[]; edges: readonly unknown[] }) {
  return [...input.tasks]
    .sort((a, b) => a.depth - b.depth || a.task_id.localeCompare(b.task_id))
    .map((task) => task.task_id)
}
