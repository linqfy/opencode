import { createVirtualizer } from "@tanstack/solid-virtual"
import { createResource, For, Match, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { authTokenFromCredentials } from "@/utils/server"
import { pageLimit, type CommandCenterTask } from "./command-center-model"

type TaskPage = { tasks: CommandCenterTask[]; edges: unknown[]; next_cursor: string | null }
type ApprovalPage = { items: Array<{ approval_id: string; decision: string; profile: string | null; recorded_at: number }>; next_cursor: string | null }
type EventRow = { seq: number; id: string; kind: string; session: string; ts: number }
type ArtifactMetadata = { artifact_id: string; mime: string; byte_length: number; hash: string }
type ArtifactRange = { bytes: number[] }
type Tab = "tasks" | "approvals" | "artifacts" | "replay" | "inspector" | "plugins"

export function CommandCenter() {
  const sdk = useSDK()
  const server = useServerSDK()
  const [ui, setUi] = createStore({ tab: "tasks" as Tab, rootId: "", sessionId: "", artifactId: "", cursor: undefined as string | undefined, canceling: "" })
  const query = () => ({ directory: sdk().directory, limit: 100 })
  const [tasks, taskActions] = createResource(
    () => ({ rootId: ui.rootId, directory: sdk().directory, cursor: ui.cursor }),
    (input) => input.rootId ? authority<TaskPage>(server(), `/experimental/authority/tasks`, { ...query(), rootId: input.rootId, cursor: input.cursor }) : Promise.resolve({ tasks: [], edges: [], next_cursor: null }),
  )
  const [approvals] = createResource(
    () => ({ directory: sdk().directory }),
    (input) => authority<ApprovalPage>(server(), `/experimental/authority/approvals`, query()),
  )
  const [replay] = createResource(
    () => ({ sessionId: ui.sessionId, directory: sdk().directory }),
    (input) => input.sessionId ? authority<EventRow[]>(server(), `/experimental/authority/sessions/${encodeURIComponent(input.sessionId)}/replay`, query()) : Promise.resolve([]),
  )
  const [context] = createResource(
    () => ({ sessionId: ui.sessionId, directory: sdk().directory }),
    (input) => input.sessionId ? authority<EventRow[]>(server(), `/experimental/authority/sessions/${encodeURIComponent(input.sessionId)}/context`, query()) : Promise.resolve([]),
  )
  const [providers] = createResource(
    () => ({ sessionId: ui.sessionId, directory: sdk().directory }),
    (input) => input.sessionId ? authority<EventRow[]>(server(), `/experimental/authority/providers`, { ...query(), sessionId: input.sessionId }) : Promise.resolve([]),
  )
  const [plugins] = createResource(
    () => ({ sessionId: ui.sessionId, directory: sdk().directory }),
    (input) => input.sessionId ? authority<EventRow[]>(server(), `/experimental/authority/plugins`, { ...query(), sessionId: input.sessionId }) : Promise.resolve([]),
  )
  const [artifact] = createResource(
    () => ({ artifactId: ui.artifactId, directory: sdk().directory }),
    (input) => input.artifactId ? authority<ArtifactMetadata | null>(server(), `/experimental/authority/artifacts/${encodeURIComponent(input.artifactId)}`, { ...query(), scope: sdk().directory }) : Promise.resolve(null),
  )
  const [artifactRange] = createResource(
    () => ui.artifactId ? { artifactId: ui.artifactId, scope: sdk().directory } : undefined,
    (input) => input ? authority<ArtifactRange>(server(), `/experimental/authority/artifacts/${encodeURIComponent(input.artifactId)}/range`, { scope: input.scope, start: 0, end: 65536 }) : Promise.resolve({ bytes: [] }),
  )
  const taskRows = () => tasks()?.tasks ?? []
  let viewport: HTMLDivElement | null = null
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({ get count() { return taskRows().length }, getScrollElement: () => viewport, estimateSize: () => 54, overscan: 8 })

  const cancel = async (taskId: string) => {
    setUi("canceling", taskId)
    await authority(server(), `/experimental/authority/tasks/${encodeURIComponent(ui.rootId)}/cancel`, { directory: sdk().directory }, {
      method: "POST",
      body: JSON.stringify({ taskId, reason: "Cancelled from Command Center", idempotencyKey: `ui-cancel:${ui.rootId}:${taskId}` }),
    })
    setUi("canceling", "")
    await taskActions.refetch()
  }

  return (
    <section data-component="ultracode-command-center" class="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-[10px] bg-v2-background-bg-base p-3 shadow-[var(--v2-elevation-raised)] sm:p-4">
      <header class="flex flex-wrap items-center justify-between gap-3">
        <div><h1 class="text-16-medium text-text-strong">Command Center</h1><p class="text-12-regular text-text-weak">Authoritative sidecar supervision</p></div>
        <div class="flex min-w-0 flex-1 flex-wrap justify-end gap-2">
          <input aria-label="Task root" class="min-h-11 min-w-40 rounded-md border border-border-base bg-background-base px-3 text-12-regular" placeholder="Root task ID" value={ui.rootId} onInput={(event) => setUi("rootId", event.currentTarget.value)} />
          <input aria-label="Session" class="min-h-11 min-w-40 rounded-md border border-border-base bg-background-base px-3 text-12-regular" placeholder="Session ID" value={ui.sessionId} onInput={(event) => setUi("sessionId", event.currentTarget.value)} />
          <input aria-label="Artifact" class="min-h-11 min-w-40 rounded-md border border-border-base bg-background-base px-3 text-12-regular" placeholder="Artifact ID" value={ui.artifactId} onInput={(event) => setUi("artifactId", event.currentTarget.value)} />
        </div>
      </header>
      <nav aria-label="Command Center views" class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <For each={["tasks", "approvals", "artifacts", "replay", "inspector", "plugins"] as Tab[]}>{(tab) => <Button class="min-h-11" size="large" variant={ui.tab === tab ? "primary" : "ghost"} onClick={() => setUi("tab", tab)}>{tab}</Button>}</For>
      </nav>
      <main class="min-h-0 flex-1 overflow-hidden">
        <Switch>
          <Match when={ui.tab === "tasks"}><div class="grid h-full min-h-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(260px,360px)]"><div class="min-h-0 overflow-auto rounded-lg border border-border-base" ref={(element) => { viewport = element }}><div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>{virtualizer.getVirtualItems().map((item) => <div class="absolute left-0 top-0 w-full px-2 py-1" style={{ transform: `translateY(${item.start}px)`, height: `${item.size}px` }}><TaskRow task={taskRows()[item.index]} canceling={ui.canceling === taskRows()[item.index]?.task_id} onCancel={cancel} /></div>)}</div></div><aside class="rounded-lg border border-border-base p-3"><h2 class="text-14-medium text-text-strong">Task DAG</h2><p class="mt-1 text-12-regular text-text-weak">{taskRows().length} tasks, {tasks()?.edges.length ?? 0} dependency edges</p><Show when={tasks()?.next_cursor}><Button class="mt-3" size="large" variant="ghost" onClick={() => setUi("cursor", tasks()?.next_cursor ?? undefined)}>Load next page</Button></Show><State resource={tasks} empty="Enter a root task ID to inspect its graph." /></aside></div></Match>
          <Match when={ui.tab === "approvals"}><Panel title="Approval Center"><State resource={approvals} empty="No finalized scoped approvals." /><For each={approvals()?.items}>{(item) => <div class="flex min-h-11 items-center justify-between border-b border-border-weaker-base py-2 text-12-regular"><span>{item.approval_id}</span><span class="text-text-weak">{item.decision} · {item.profile ?? "default"}</span></div>}</For></Panel></Match>
          <Match when={ui.tab === "artifacts"}><Panel title="Artifact Viewer"><State resource={artifact} empty="Enter an artifact ID to inspect bounded metadata." /><Show when={artifact()}><pre class="mt-3 overflow-auto rounded-md bg-background-base p-3 text-12-regular">{JSON.stringify(artifact(), null, 2)}</pre><Show when={artifactRange()}><pre class="mt-3 max-h-96 overflow-auto rounded-md bg-background-base p-3 text-12-regular">{new TextDecoder().decode(new Uint8Array(artifactRange()?.bytes ?? []))}</pre></Show></Show></Panel></Match>
          <Match when={ui.tab === "replay"}><EventPanel title="Session Replay" resource={replay} empty="Enter a session ID to replay its bounded event page." /></Match>
          <Match when={ui.tab === "inspector"}><div class="grid gap-3 md:grid-cols-2"><EventPanel title="Context & Token Inspector" resource={context} empty="Enter a session ID to inspect context and prompt events." /><EventPanel title="Provider Compatibility" resource={providers} empty="No provider attempts in this scoped session." /></div></Match>
          <Match when={ui.tab === "plugins"}><Panel title="Plugin Manager"><p class="mb-3 text-12-regular text-text-weak">Sidecar-observed tools and plugin activity for the selected session.</p><EventPanel title="" resource={plugins} empty="Enter a session ID to inspect plugin activity." /></Panel></Match>
        </Switch>
      </main>
    </section>
  )
}

function TaskRow(props: { task: CommandCenterTask | undefined; canceling: boolean; onCancel: (id: string) => Promise<void> }) {
  return <Show when={props.task}>{(task) => <div class="flex min-h-11 items-center gap-3 rounded-md border border-border-weaker-base bg-background-base px-3 text-12-regular"><span class="min-w-0 flex-1 truncate" style={{ "padding-left": `${task().depth * 16}px` }}>{task().task_id}</span><span class="text-text-weak">{task().state}</span><IconButton aria-label={`Cancel ${task().task_id}`} disabled={props.canceling || ["completed", "failed", "cancelled"].includes(task().state)} icon="close" onClick={() => void props.onCancel(task().task_id)} /></div>}</Show>
}

function Panel(props: { title: string; children: JSX.Element }) { return <div class="h-full overflow-auto rounded-lg border border-border-base p-3"><Show when={props.title}><h2 class="text-14-medium text-text-strong">{props.title}</h2></Show>{props.children}</div> }
function EventPanel(props: { title: string; resource: { (): EventRow[] | undefined; loading: boolean; error: unknown }; empty: string }) { return <Panel title={props.title}><State resource={props.resource} empty={props.empty} /><For each={props.resource()}>{(event) => <div class="border-b border-border-weaker-base py-2 text-12-regular"><span class="text-text-weak">#{event.seq}</span> {event.kind}</div>}</For></Panel> }
function State(props: { resource: { loading: boolean; error: unknown; (): unknown }; empty: string }) {
  const value = () => props.resource()
  return <><Show when={props.resource.loading}><p class="mt-3 text-12-regular text-text-weak">Loading…</p></Show><Show when={Boolean(props.resource.error)}><p class="mt-3 text-12-regular text-red-500" role="alert">Unable to load authority data.</p></Show><Show when={!props.resource.loading && !props.resource.error && (!Array.isArray(value()) || (value() as unknown[]).length === 0)}><p class="mt-3 text-12-regular text-text-weak">{props.empty}</p></Show></>
}
async function authority<T = unknown>(server: ServerSDK, path: string, query: Record<string, string | number | undefined>, init?: RequestInit): Promise<T> {
  const url = new URL(path, server.url)
  Object.entries(query).forEach(([key, value]) => { if (value !== undefined) url.searchParams.set(key, String(value)) })
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(server.server.http.password
        ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.server.http.username, password: server.server.http.password })}` }
        : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as T
}
