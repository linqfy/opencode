import type { Effect, Scope } from "effect"
import type { Registration } from "./registration.js"

export interface SessionStarted {
  readonly sessionID: string
  readonly directory: string
  readonly timestamp: number
}

export interface ToolProposed {
  readonly sessionID: string
  readonly assistantMessageID: string
  readonly callID: string
  readonly tool: string
  readonly providerExecuted: boolean
}

export interface TurnCompleted {
  readonly sessionID: string
  readonly assistantMessageID: string
  readonly finish: string
  readonly timestamp: number
}

export interface ArtifactStored {
  readonly artifactID: string
  readonly mime: string
  readonly byteLength: number
  readonly hash: string
}

export interface Hooks {
  readonly onSessionStarted: (
    callback: (event: SessionStarted) => Effect.Effect<void> | void,
  ) => Effect.Effect<Registration, never, Scope.Scope>
  readonly onToolProposed: (
    callback: (event: ToolProposed) => Effect.Effect<void> | void,
  ) => Effect.Effect<Registration, never, Scope.Scope>
  readonly onTurnCompleted: (
    callback: (event: TurnCompleted) => Effect.Effect<void> | void,
  ) => Effect.Effect<Registration, never, Scope.Scope>
  readonly onArtifactStored: (
    callback: (event: ArtifactStored) => Effect.Effect<void> | void,
  ) => Effect.Effect<Registration, never, Scope.Scope>
}
