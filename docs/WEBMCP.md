# WebMCP Exchange Contract

This document describes the conventions implemented by 3way version 0.1. They are not part
of the WebMCP browser standard, and no interoperability with unrelated sites is claimed.

### Keyholder mode — the default

By default the widget mounts with no text composer: the site's agent and the visiting
agent transact over the tool registry described below, in one attributed ledger, and the
person's only input is the hardware-gesture confirmation a gated tool requires. Nothing an
agent can drive doubles as a place for a person to type, so there is no human-typing
surface for a synthetic input to impersonate.

**Composer mode** (`data-3way-input="composer"`, or `mount({ composer: true })`) adds that
text box back for pages whose exchange needs the person to volunteer information no tool
call surfaces — the clinic demo runs this mode because its disclosure flow depends on facts
only the person holds.

## Registration

[`packages/widget/src/webmcp.ts`](../packages/widget/src/webmcp.ts) registers every tool
with `name`, `description`, `inputSchema`, optional `annotations`, and `execute`. It checks
`document.modelContext` first and the older `navigator.modelContext` second. If neither
usable surface exists, the person-facing service chat continues without visiting-agent
tools.

Registration is asynchronous and fire-and-forget. Rejections are logged without escaping
into the host page. A shared `AbortController` supplies the registration lifetime, and the
widget aborts it during `destroy()`.

### Reaching the tools without a WebMCP consumer

A registered tool is only in an agent's own tool list if the agent's runtime consumes
WebMCP. Measured on 2026-09-01 (see [runtime findings](research/runtime-findings.md), run D):
on Chrome 152, where `document.modelContext` is native, an agent extension listed none of
the page's tools, yet could call them from page script through the standard API. On the
native surface `executeTool` takes the descriptor object from `getTools()` and the
arguments as a JSON string, and returns the result as JSON text; the vendored polyfill
accepts either form and returns an object. Calls made this way reach the same registered
`execute` and are stamped `agent-autonomous`. The demo bar on each demo page renders this
recipe and the live tool list in the light DOM, and `/for-agents` and `/llms.txt` repeat it
for any agent that reads the site, because the widget's own text lives in a shadow root the
measured agent never saw.

## Participant origins

[`packages/widget/src/types.ts`](../packages/widget/src/types.ts) defines exactly four
origins:

| Origin | Implemented meaning |
|---|---|
| `human-direct` | Entered through the person-facing widget or its post-ceremony execution path |
| `agent-relay` | The visiting agent says it is relaying the person's words |
| `agent-autonomous` | The visiting agent speaks or calls a tool as itself |
| `site-agent` | The service agent or a completed domain tool contributes the entry |

Origins are channel attribution, not identity or authorization. WebMCP calls are stamped
`agent-autonomous`; `send_message` may choose `agent-relay` with `intent: 'relay'`.

## Shared transcript

[`packages/widget/src/bus.ts`](../packages/widget/src/bus.ts) stores full `LogEntry` values.
The agent-visible projection from [`packages/widget/src/tools.ts`](../packages/widget/src/tools.ts)
contains only:

```ts
type PublicEntry = {
  origin: 'human-direct' | 'agent-relay' | 'agent-autonomous' | 'site-agent';
  text: string;
  fromHuman: boolean;
};
```

`fromHuman` means `origin === 'human-direct'`; it is not proof. `get_conversation` returns
the complete projected transcript. Sensitive confirmation tokens, request bindings, and
structured `context` never appear in `PublicEntry`.

## Contributing context and messages

Both domain registries implement the same visiting-agent inputs:

- `provide_context({ summary, data? })` appends `summary` as `agent-autonomous` and keeps
  `data` as structured context on the internal bus entry.
- `send_message({ text, intent? })` appends `agent-relay` only when `intent` is exactly
  `relay`; otherwise it appends `agent-autonomous`. Its successful result contains `ok`,
  `id`, and a `hint` to call `await_reply`.
- Person-typed text enters through `sendUserText` in
  [`packages/widget/src/session.ts`](../packages/widget/src/session.ts) as `human-direct`.
- Service-agent text is appended by that session as `site-agent`.

The service-agent view excludes `provide_context` and `send_message`, and both tool bodies
also refuse a `site-agent` caller defensively.

## Missing-information response

`request_records_disclosure` in
[`packages/widget/src/clinic.ts`](../packages/widget/src/clinic.ts) refuses to guess when no
visits match or no recipient is named. Its implemented result has these exact fields:

```ts
type NeedsInformation = {
  ok: false;
  needsInformation: true;
  origin: string | undefined;
  question: string;
  message: string;
  agentHint: string;
};
```

`question` is for the person, `message` states why nothing happened, and `agentHint` tells
the visiting agent to ask through `send_message` and then call `await_reply`. In a mounted
widget, `origin` is the page's `location.origin`; the lower-level registry permits it to be
undefined for DOM-free construction.

## Human-confirmation response

The mounted public response from [`packages/widget/src/gates.ts`](../packages/widget/src/gates.ts)
uses this discriminator:

```ts
type NeedsHumanConfirmation = {
  ok: false;
  needsHumanConfirmation: true;
  origin: string;
  requestId: string;
  message: string;
  agentHint?: string;
};
```

`ok: false` and `needsHumanConfirmation: true` mean the action did not happen. `origin` and
`requestId` identify the page-local pending request. `message` is safe to relay to the
person; `agentHint` is machine handling guidance. The reusable low-level helper types
`origin` as optional because tests and non-DOM registry construction may omit `siteOrigin`,
but [`packages/widget/src/index.ts`](../packages/widget/src/index.ts) always supplies
`location.origin` for a mounted exchange.

## Awaiting execution and terminal receipts

After confirmation is recorded, an agent-origin call to a gated tool cannot spend it. While
the widget's human path is completing the action, the implemented nonterminal result is:

```ts
{
  ok: false,
  awaitingHumanExecution: true,
  terminal: false,
  origin,
  requestId,
  message,
  agentHint,
}
```

The widget executes once with `origin: 'human-direct'`. The filing agent may then poll the
same gated tool with the same `requestId` to read a retained terminal receipt; that read
cannot re-enter the gate or executor. Terminal results set `terminal: true`, an `outcome` of
`completed`, `refused`, or `indeterminate`, `origin`, and `requestId`. Completed receipts
also contain action-specific server data plus `orderId` and `path`.

[`packages/widget/src/tools.ts`](../packages/widget/src/tools.ts) retains a sensitive result
only for the origin that filed the request, for two deliveries and at most five minutes.
After consumption, expiry, eviction, or an unavailable payload, a tombstone returns
`receiptStatus` as `consumed`, `expired`, `evicted`, or `unavailable` without the payload.
Tombstones expire after 30 minutes. An `indeterminate` outcome explicitly warns callers not
to retry because the server may have acted before the response was lost.

## Holding a refused call open

A visiting agent that receives the human-confirmation response is expected to stay
available for the outcome. In a live run it did not: told in `agentHint` to call
`await_reply`, the agent reported the handoff and ended its turn, the person confirmed,
the action completed, and no call was open to receive it.

Since 2026-09-01 the gated tools therefore hold the line themselves. When a call from a
visiting-agent origin (`agent-autonomous` or `agent-relay`) would return either the
human-confirmation response or the awaiting-execution response, the gateway holds that
call open until the first of:

- the request reaches a terminal state — the call returns the terminal receipt, and this
  counts as one of its two deliveries exactly as a poll would;
- the person appends a transcript entry that is not a confirmation — the call returns the
  same nonterminal response at once, with `agentHint` saying the customer replied;
- the bound elapses — the call returns the same nonterminal response, with `agentHint`
  stating how long it waited and that calling again keeps waiting.

The response shapes are unchanged. The hold is scoped to visiting-agent origins only: the
service agent's call is awaited inside its own live turn, and the human path is the
executor. One hold exists per `(tool, requestId)`; a reissued call takes over the wait
and the earlier call returns saying so, so two holds can never consume both receipt
deliveries. Holds are released on gateway teardown. The service agent's transcript entries
and confirmations of other requests do not end a hold; they ride back on
`room_since_last_call` when it returns.

`GatewayDeps.holdMs` defaults to 0; `mount()` passes 25,000 ms, and `WidgetConfig.holdMs`
overrides it. The bound is the same assumption `await_reply` makes about agent-runtime
tool-call timeouts, which the [runtime findings](research/runtime-findings.md) record as
unmeasured; `probe_slow` on the probe page accepts `seconds` so a runtime can be checked
in one call. Live agent behavior against a held call has not been measured.

## Staying available with await_reply

`await_reply({ timeout_ms? })` waits on the bus instead of polling. Both domain registries
default to 25,000 ms and clamp the request to 1,000–30,000 ms. If an unseen entry already
exists it returns immediately. The direct result is:

```ts
{ waited_ms: number, nothing_new: boolean }
```

The new transcript entries arrive through the same piggyback wrapper as any other tool
result. `await_reply` cannot wake an agent that did not choose to call it, and it is omitted
from the service-agent view because that session already receives bus events. For the
confirmation handoff specifically, the gated tools now hold their own refused call open
(previous section), so `await_reply` is needed there only when the person is slower than
the bound; it remains the mechanism for replies to `send_message` and for missing-information
round trips. See the
measured [20-run trial](research/await-reply-trial.md).

## Transcript piggybacking

`withPiggyback` in [`packages/widget/src/tools.ts`](../packages/widget/src/tools.ts) owns one
cursor per visiting-agent tool view. After each tool execution it appends:

```ts
{ room_since_last_call: PublicEntry[] }
```

The list contains entries newer than that view's prior cursor, including events that
arrived while a blocking tool was waiting. A non-object tool result would be wrapped under
`value`, although the shipped domain tools return objects. The Realtime service agent is
not piggyback-wrapped because it subscribes directly to the bus.

## Consumer-specific tool views

`scopeFor` in [`packages/widget/src/tools.ts`](../packages/widget/src/tools.ts) returns the
full registry only for the recognized `visiting-agent` consumer. The `site-agent` receives
the same underlying domain implementations except `send_message`, `provide_context`, and
`await_reply`. Any unrecognized future consumer value also falls into that restricted view.

The person uses the widget rather than an agent tool catalogue. After a successful
confirmation, [`packages/widget/src/index.ts`](../packages/widget/src/index.ts) calls the
same gated implementation used by both agent views with a `human-direct` context. Thus one
implementation has three consumer paths without granting all three the same capabilities.

## Implemented boundaries

- WebMCP is pull-only here. The page cannot push a notification to a visiting agent.
- One widget mount owns one bus, one registered visiting-agent surface, and one service
  session. WebMCP does not expose a per-call visitor identity within that surface.
- The `origin` field establishes the ingress channel only. It is never sufficient for
  authorization.
- Tool failures are contained as structured results; they do not become proof that an
  action failed. Network ambiguity after `/api/act` produces `outcome: 'indeterminate'`.
- The polyfill keeps the widget API-compatible on browsers without a native surface, but a
  polyfilled registration is not automatically visible to a visiting agent.
- Human confirmation and server execution semantics are part of 3way, not WebMCP itself.
  See [Assurance and Security Boundary](SECURITY.md).
