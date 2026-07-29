import type { PlannerMessage, PlannerPart } from "./types"

// A part is protected from clearing if the integration layer tagged it with any
// protected category (spec section 8: active failures, user-authored facts,
// permissions/constraints, invoked skill content, current task state).
export const isPartProtected = (part: PlannerPart): boolean =>
  Boolean(
    part.userAuthored ||
      part.permissionOrConstraint ||
      part.invokedSkill ||
      part.currentTask ||
      part.activeFailure,
  )

// Index of the user message that begins the keepRecentTurns-th turn from the
// end. Messages at or after this index are in the recent tail and protected.
// Floors at 0 when the history has fewer turns than requested.
export const recentTailStart = (messages: readonly PlannerMessage[], keepRecentTurns: number): number => {
  let turns = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      turns++
      if (turns >= keepRecentTurns) return i
    }
  }
  return 0
}
