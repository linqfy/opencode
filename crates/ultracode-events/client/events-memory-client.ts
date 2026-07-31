import { EventsClient } from "./events-client"

export class EventsMemoryJobClient {
  constructor(private readonly events: EventsClient) {}

  claimMemoryJob() {
    return this.events.claimMemoryJob()
  }

  listMemoryRecords(limit?: number) {
    return this.events.listMemoryRecords(limit)
  }

  async proposeCommit(key: string, kind: { readonly kind: string; readonly data: unknown }): Promise<void> {
    await this.events.proposeCommit(key, kind)
  }

  async openTranscript(artifactId: string, sourceSession: string): Promise<string> {
    const bytes = await this.events.openRange(artifactId, sourceSession, 0, Number.MAX_SAFE_INTEGER)
    return new TextDecoder().decode(bytes)
  }
}
