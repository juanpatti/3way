# Assurance and Security Boundary

3way separates conversational attribution from authorization. The browser coordinates the
exchange; the Cloudflare Worker decides whether a consequential action may execute.

## What the system establishes

- [`packages/widget/src/types.ts`](../packages/widget/src/types.ts) and
  [`packages/widget/src/bus.ts`](../packages/widget/src/bus.ts) preserve the ingress path
  for each transcript entry.
- [`packages/widget/src/verify.ts`](../packages/widget/src/verify.ts) and
  [`worker/src/index.ts`](../worker/src/index.ts) can establish that a platform credential
  completed a WebAuthn ceremony for one bound request and tool.
- [`worker/src/index.ts`](../worker/src/index.ts) binds the action subject before the
  ceremony, checks a bearer token against the same `requestId` and `tool`, re-derives
  eligibility, and returns an explicit outcome.
- [`packages/widget/src/tools.ts`](../packages/widget/src/tools.ts) keeps action preparation,
  confirmation, execution, and terminal receipt states distinct.

These are implementation claims about the provided paths. They are not a general identity,
intent, or informed-consent protocol.

## What attribution does not establish

`human-direct`, `agent-relay`, `agent-autonomous`, and `site-agent` name the 3way ingress
path, not a cryptographically authenticated speaker. In particular, `agent-relay` records
the visiting agent's claim that it is relaying the person; `fromHuman` means an entry used
the person-facing path; and neither value authorizes an action by itself.

WebAuthn proves a present user completed a ceremony bound to one action; it does not prove
the page described the action honestly or that the person understood it. The demo also
uses an anonymous browser `deviceId` as its credential lookup key. It does not authenticate
a named account or connect the ceremony to the display name in the widget.

## WebAuthn commitment flow

1. A domain tool in [`packages/widget/src/tools.ts`](../packages/widget/src/tools.ts) or
   [`packages/widget/src/clinic.ts`](../packages/widget/src/clinic.ts) creates an eligible
   pending request but does not perform the action.
2. [`packages/widget/src/ui/modal.ts`](../packages/widget/src/ui/modal.ts) shows the action,
   its subject, and the eligibility basis. It also requires `Event.isTrusted`, which is a
   measured signal but not a security boundary.
3. [`packages/widget/src/session.ts`](../packages/widget/src/session.ts) passes the pending
   request fields to [`packages/widget/src/verify.ts`](../packages/widget/src/verify.ts).
4. `/api/webauthn/options` in [`worker/src/index.ts`](../worker/src/index.ts) selects
   registration or authentication and stores the challenge together with the tool, device,
   tenant, and bound subject for 300 seconds.
5. `/api/webauthn/verify` reads and then deletes the challenge, verifies the expected origin
   and relying party, requires user verification, and mints an opaque 300-second token.
6. `/api/act` looks up that token, requires the same `requestId` and `tool`, checks current
   policy, executes the subject stored with the token, and records the outcome.

The challenge deletion is fail-closed on a reported KV error, but it is not an atomic
consume. Workers KV is eventually consistent and has no compare-and-swap transaction around
the read and delete. Concurrent requests, or a request in another location observing a stale
value after deletion, can reuse the same challenge. Successful repeated verification can
therefore mint multiple opaque tokens, each still bound to the same request, tool, device,
tenant, and subject context.

## Action and subject binding

The binder in [`worker/src/index.ts`](../worker/src/index.ts) requires different fields per
tool: `confirm_return` binds `orderId`, `itemId`, and `reason`; `cancel_order` binds
`orderId`; `change_address` binds `orderId` and `address`; `disclose_order_records` binds
`orderId`; and `release_records` binds visit IDs through `orderId`, its named recipient
through `itemId`, and its disclosure `scope`.

The strong `/api/act` path does not trust replacements for those fields in the action
request. A token cannot be redirected to a different request, tool, or subject. This still
does not prove that a compromised page displayed the same subject it sent to the Worker.

The action-token record is read and later overwritten with `used: true` and the result. If a
later read observes that write, `/api/act` returns the prior result without executing again.
That is not atomic single-use: concurrent requests can both read `used: false`, and a
cross-location request can observe a stale unused record after the write. Either case can
execute the same bound action more than once. The request/tool/subject binding prevents
redirection to a different action context; it does not prevent duplicate execution within
the bound context.

## Assurance levels

The implemented confirmation proof union in
[`packages/widget/src/types.ts`](../packages/widget/src/types.ts) has two levels:

- `webauthn`: the Worker verified a platform-credential signature with user verification.
- `trusted-click`: the Worker recorded a click after the client-side availability helper
  returned false. That occurs when the browser reports no platform authenticator **or when
  the authenticator probe throws and the helper converts the exception to false**. The
  record has a token and action binding but no device signature.

[`packages/widget/src/session.ts`](../packages/widget/src/session.ts) also contains an
explicit `requireHardwareConfirmation: false` demonstration mode. It records a bare
`human-direct` confirmation with no proof and returns `{ method: 'none' }`. That mode is a
deliberate reproduction of the vulnerable design, not an assurance level.

## Deployed demonstration fallback

The live shop and clinic configuration in [`config/policy.ts`](../config/policy.ts) and
[`config/clinic.ts`](../config/clinic.ts) opts into `trusted-click` because the measured
ChatGPT in-app runtime exposed WebMCP but reported no platform authenticator.

The client enters this path only after `isAuthenticatorAvailable()` returns false. That
wrapper calls `isUserVerifyingPlatformAuthenticatorAvailable()` but catches any exception
and also returns false, so the deployed fallback can activate on either reported absence or
probe failure. It obtains a short-lived session ticket from the Origin-checked
`/api/session`, then sends that ticket and the bound subject to `/api/trusted-click`. The
Worker refuses a device ID that already has a registered credential and stamps the result
`trusted-click`.

The ticket is checked and then deleted before token minting, but this is another non-atomic
Workers KV read/delete sequence, not guaranteed single-use. Concurrent or stale reads can
reuse one ticket and mint multiple `trusted-click` tokens for the same device, tenant,
request, tool, and subject context. Each token remains bound, but the ticket does not limit
the context to exactly one minted token.

This narrows access but does not authenticate the caller. A non-browser client can forge
the expected `Origin` header, obtain a ticket for a fresh device ID, mint a `trusted-click`
token, and spend it. The measured runtime evidence is in
[`docs/research/runtime-findings.md`](research/runtime-findings.md).

Because activation on probe failure is indistinguishable from reported absence here, this
fallback is demo-only and unsafe for production. A failed probe is not evidence that weaker
authorization is appropriate.

## Threat boundary

The WebAuthn path defends against a visiting agent limited to WebMCP and against an agent
operating the visible interface: neither can supply a platform credential signature merely
by calling a tool or clicking. The Worker remains authoritative even if the advisory
browser gate is skipped.

It does not defend against code executing inside the page, including a hostile extension
that replaces browser APIs or races to steal a legitimately issued bearer token. A
compromised page can also bind one subject while displaying another. Short token lifetimes,
tool/request/subject binding, and result retention narrow the impact; they do not make an
untrusted client trustworthy.

`Event.isTrusted` is required by the UI because it stopped one measured in-browser agent,
but another measured agent produced `isTrusted=true`. Origin allowlisting on
`/api/realtime-token` and `/api/session` limits ordinary cross-site browser calls; it is not
authentication because non-browser callers choose their Origin header. The deployed
`trusted-click` path is outside the strong WebAuthn boundary described above.

## Production guidance

For production use, configure `onMissingAuthenticator: 'refuse'`. The deployed challenge
demo opts into `trusted-click` only so the flow can be completed in a measured judging
runtime that exposes WebMCP but no platform authenticator. `trusted-click` is an auditable
lower-assurance record, not cryptographic proof of human presence, and it is forgeable by
a caller that can satisfy the demo's session-ticket path.

In the current client, “no platform authenticator” includes both a false availability result
and an exception thrown by the availability probe, because the helper maps both to false.
Production must refuse in either case.

Also keep `requireHardwareConfirmation: true`; bind the ceremony to an authenticated account
instead of the demo's anonymous device ID; serve reviewed, pinned widget code from the
service's own trust boundary; protect metered endpoints with real abuse controls; and use a
linearizable coordinator for challenge, ticket, and action-token consumption. Treat a
missing or failed authenticator probe as refusal, never as evidence that weaker authorization
is safe.
