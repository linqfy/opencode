export * as PermissionV2 from "./permission"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect as EffectRuntime, Layer, Schema } from "effect"
import { Permission } from "@opencode-ai/schema/permission"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { SessionV2 } from "./session"
import { SessionStore } from "./session/store"
import { Wildcard } from "./util/wildcard"
import { PermissionSaved } from "./permission/saved"

export { Effect, GrantScope, Rule, Ruleset } from "@opencode-ai/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const Profile = Permission.Profile
export type Profile = typeof Profile.Type

export const Grant = Permission.Grant
export type Grant = typeof Grant.Type

export const Decision = Permission.Decision
export type Decision = typeof Decision.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
  turn: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
  expiresAt: Schema.Number.pipe(Schema.optional),
  idempotencyKey: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
  decision: Decision.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class DeclinedError extends Schema.TaggedErrorClass<DeclinedError>()("PermissionV2.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("PermissionV2.BlockedError", {
  rules: Permission.Ruleset,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export function mergeNarrowing(parent: Permission.Ruleset, child: Permission.Ruleset): Permission.Ruleset {
  return [
    ...parent,
    ...child.map((rule) => {
      const matched = parent.findLast(
        (candidate) =>
          (Wildcard.match(rule.action, candidate.action) || Wildcard.match(candidate.action, rule.action)) &&
          (Wildcard.match(rule.resource, candidate.resource) || Wildcard.match(candidate.resource, rule.resource)),
      )
      if (!matched || matched.effect === "allow" || rule.effect !== "allow") return rule
      return { ...rule, effect: matched.effect }
    }),
  ]
}

export function resolveProfile(name: string, profiles: ReadonlyArray<Profile>): Profile | undefined {
  const selected = profiles.find((profile) => profile.name === name)
  if (!selected) return
  const parents: Profile[] = []
  let current: Profile | undefined = selected
  while (current?.parent) {
    current = profiles.find((profile) => profile.name === current?.parent)
    if (!current || parents.some((profile) => profile.name === current?.name)) return
    parents.unshift(current)
  }
  const rules = parents.reduce<Permission.Ruleset>((result, parent) => mergeNarrowing(result, parent.rules), [])
  return { ...selected, rules: mergeNarrowing(rules, selected.rules) }
}

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionV2.NotFoundError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionV2.NotFoundError>
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionV2.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentV2.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const pending = new Map<ID, Pending>()
    const grants = new Map<string, Grant>()
    const replies = new Map<string, ReplyInput>()

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new DeclinedError()), {
        discard: true,
      }).pipe(
        EffectRuntime.ensuring(
          EffectRuntime.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
      )
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionV2.ID,
      agentID?: AgentV2.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      const profile = agent?.permissionProfile
      return {
        rules: profile ? mergeNarrowing(profile.rules, agent?.permissions ?? []) : agent?.permissions ?? missingAgentPermissions,
        agent: agent?.id,
        profile,
      }
    })

    function denied(input: AssertInput, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      const configuredRuleset = yield* configured(input.sessionID, input.agent)
      const rules = configuredRuleset.rules
      const configuredRules = input.resources.map((resource) => evaluate(input.action, resource, rules))
      const decision = (effect: Permission.Effect, source: Permission.Decision["approvalSource"], grant?: Grant) => ({
        matchedRule: configuredRules.findLast((rule) => rule.effect === effect),
        profile: configuredRuleset.profile?.name,
        profileVersion: configuredRuleset.profile?.version,
        requestedAction: input.action,
        requestedResources: input.resources,
        agent: input.agent ?? configuredRuleset.agent,
        turn: input.turn,
        approvalSource: source,
        sandboxProfile: configuredRuleset.profile?.sandboxProfile,
        grantScope: grant?.scope,
        expiresAt: grant?.expiresAt,
        idempotencyKey: grant?.idempotencyKey,
      } satisfies Decision)
      if (denied(input, rules)) return { effect: "deny" as const, rules, decision: decision("deny", "policy") }
      const grant = Array.from(grants.values()).find(
        (item) =>
          item.action === input.action &&
          (!item.expiresAt || item.expiresAt > Date.now()) &&
          (!item.sessionID || item.sessionID === input.sessionID) &&
          input.resources.every((resource) => item.resources.some((saved) => Wildcard.match(resource, saved))),
      )
      if (grant) {
        if (grant.scope === "once") grants.delete(grant.idempotencyKey ?? "")
        return { effect: "allow" as const, rules, decision: decision("allow", "grant", grant) }
      }
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      return { effect, rules: all, decision: decision(effect, "policy") }
    })

    function request(input: AssertInput, decision: Decision): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
        decision,
      }
    }

    function finalizedDecision(request: Request): Decision {
      return {
        ...(request.decision ?? {
          requestedAction: request.action,
          requestedResources: request.resources,
          approvalSource: "policy" as const,
        }),
        approvalSource: "user",
      }
    }

    const create = (request: Request, agent?: AgentV2.ID) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item = { request, agent, deferred }
          if (pending.has(request.id)) return yield* EffectRuntime.die(`Duplicate pending permission ID: ${request.id}`)
          pending.set(request.id, item)
          yield* events
            .publish(Event.Asked, request)
            .pipe(EffectRuntime.onError(() => EffectRuntime.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input, result.decision)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect, decision: result.decision }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const result = yield* evaluateInput(input)
          if (result.effect === "deny") {
            return yield* new BlockedError({
              rules: relevant(input, result.rules),
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(request(input, result.decision), input.agent)
          return yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.catchTag("PermissionV2.DeclinedError", (error) => EffectRuntime.die(error)),
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                pending.delete(item.request.id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          if (input.idempotencyKey && replies.has(input.idempotencyKey)) return
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          const decision = finalizedDecision(existing.request)

          if (input.reply === "reject") {
            yield* events.publish(Event.Replied, {
              sessionID: existing.request.sessionID,
              requestID: existing.request.id,
              reply: input.reply,
              decision,
            })
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* events.publish(Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
                decision: finalizedDecision(item.request),
              })
              yield* Deferred.fail(item.deferred, new DeclinedError())
              pending.delete(id)
            }
            return
          }

          if (input.reply === "always" && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
          }
          const grant =
            input.reply === "once" || input.reply === "session" || input.reply === "project" || input.reply === "always"
              ? {
                  scope: input.reply === "always" ? ("project" as const) : input.reply,
                  action: existing.request.action,
                  resources: existing.request.save?.length ? existing.request.save : existing.request.resources,
                  sessionID:
                    input.reply === "session" || input.reply === "once" ? existing.request.sessionID : undefined,
                  expiresAt: input.expiresAt,
                  idempotencyKey: input.idempotencyKey ?? existing.request.id,
                }
              : undefined
          if (input.reply === "once" || input.reply === "session" || input.reply === "project" || input.reply === "always") {
            grants.set(grant!.idempotencyKey!, grant!)
          }
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
            decision,
            grant,
          })
          if (input.idempotencyKey) replies.set(input.idempotencyKey, input)
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (input.reply !== "always" || !existing.request.save?.length) return

          const rememberedRules = yield* savedRules()
          for (const [id, item] of pending) {
            const input = { ...item.request }
            const configuredRuleset = yield* configured(item.request.sessionID, item.agent).pipe(
              EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
            )
            if (!configuredRuleset) continue
            const rules = configuredRuleset.rules
            if (denied(input, rules)) continue
            const effective = [...rules, ...rememberedRules]
            if (
              !item.request.resources.every(
                (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
              )
            )
              continue
              yield* events.publish(Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "always",
                decision: finalizedDecision(item.request),
              })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (sessionID: SessionV2.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, AgentV2.node, SessionStore.node, PermissionSaved.node],
})
