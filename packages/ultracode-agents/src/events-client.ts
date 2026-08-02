export interface TaskRecord {
  readonly root_id: string
  readonly task_id: string
  readonly parent_task_id: string | null
  readonly depth: number
  readonly state_changing: boolean
  readonly budget: number
  readonly reserved_parent: number
  readonly reserved_child_pool: number
  readonly reserved_synthesis: number
  readonly budget_used: number
  readonly budget_reclaimed?: number
  readonly state: string
  readonly dependencies: readonly string[]
  readonly worktree_id?: string
}

export interface MailboxMessage {
  readonly root_id: string
  readonly message_id: string
  readonly sender_task_id: string
  readonly recipient_task_id: string
  readonly sequence: number
  readonly summary: string
  readonly artifact_ids: readonly string[]
  readonly changed_paths: readonly string[]
  readonly test_summary: string | null
  readonly blocked_reason: string | null
  readonly acknowledged: boolean
}

export interface TaskDeliverable {
  readonly root_id: string
  readonly task_id: string
  readonly status: string
  readonly summary: string
  readonly artifact_ids: readonly string[]
  readonly changed_paths: readonly string[]
  readonly test_summary: string | null
}

export type TaskEvent = {
  readonly kind: string
  readonly data: Record<string, unknown>
}

export interface SchedulerEventClient {
  listTasks(rootId: string, limit: number): Promise<readonly TaskRecord[]>
  listMailbox(rootId: string, recipientTaskId: string, afterSequence: number, limit: number): Promise<readonly MailboxMessage[]>
  listTaskDeliverables(rootId: string, limit: number): Promise<readonly TaskDeliverable[]>
  proposeCommit(key: string, kind: TaskEvent): Promise<{ readonly seq: number; readonly hash: string; readonly duplicate: boolean }>
}
