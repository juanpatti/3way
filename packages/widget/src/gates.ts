import type { Bus } from './bus';
import type { GateResult, PolicyRules } from './types';

/**
 * Strips everything but the characters a real requestId is made of, and caps length,
 * before a caller-supplied id is echoed back into a refusal that may land on the shared
 * transcript. Without this an agent could set requestId to prose aimed at the human or
 * the store's agent — prompt injection carried through an error string.
 */
function sanitizeRequestId(requestId: string): string {
  return requestId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'request';
}

/**
 * ADVISORY. This is the browser-side check: it gives the agent a fast, legible refusal
 * and drives the UI. It is NOT the authorization boundary — anything with code execution
 * in this page could patch it. The Worker performs the authoritative check against a
 * server-verified, single-use token immediately before acting.
 *
 * Never prompt-driven: reads stamped log fields only, never model output.
 */
export function checkGate(
  toolName: string,
  requestId: string,
  bus: Bus,
  rules: PolicyRules,
): GateResult {
  // A malformed policy must fail closed, not open — never treat "we can't tell if this
  // is gated" as "it isn't".
  if (!Array.isArray(rules.requiresHumanDirect)) {
    return { ok: false, reason: `${toolName} cannot be authorized: policy configuration is invalid.` };
  }

  if (!rules.requiresHumanDirect.includes(toolName)) return { ok: true };

  // `undefined` would otherwise compare equal to any ordinary chat entry's absent
  // `confirms` field, making a missing requestId a wildcard match. Reject it outright
  // rather than trusting a caller to have coerced it first.
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return { ok: false, reason: `${toolName} needs a valid confirmation request id before it can proceed.` };
  }

  // Only an explicit `false` selects the deliberately weak path. Missing, undefined, or
  // garbage must default to the hardware path — this is the one flag that must never
  // fail open. On the hardware path, which recognized assurance level satisfies the
  // gate depends on the CURRENT policy read here, not on whichever level the
  // confirming entry happened to carry: if onMissingAuthenticator is 'trusted-click',
  // either level (hasAssuredConfirmation) is accepted; otherwise only the strictly
  // cryptographic one (hasVerifiedConfirmation) is. A bus entry recorded while the
  // policy briefly permitted trusted-click must not go on satisfying this gate after
  // the policy has reverted to 'refuse' — this file's own "never fail open on a flag"
  // discipline applies to onMissingAuthenticator exactly as it applies to
  // requireHardwareConfirmation above. (This is advisory only, same as everywhere
  // else in this function — /api/act re-checks the live policy independently, at
  // spend time, against the token's own record; see worker/src/index.ts.)
  const satisfied = rules.requireHardwareConfirmation === false
    ? bus.hasHumanConfirmation(requestId)   // deliberately weak; demo toggle only
    : rules.onMissingAuthenticator === 'trusted-click'
      ? bus.hasAssuredConfirmation(requestId, toolName)
      : bus.hasVerifiedConfirmation(requestId, toolName);
  if (satisfied) return { ok: true };

  return {
    ok: false,
    reason:
      `${toolName} needs the customer to confirm it in person. ` +
      `Ask them to confirm request ${sanitizeRequestId(requestId)} in the widget — it will ask them to ` +
      `complete the confirmation shown there. You cannot do this step for them.`,
    agentHint:
      'Nothing is pushed to you on this page. Call await_reply to find out when they have ' +
      'confirmed, instead of ending your turn while the customer is still working.',
  };
}

/** A gate rejection is a conversational handoff, not an error. */
export interface ConfirmationNeededResult {
  ok: false;
  needsHumanConfirmation: true;
  /**
   * Which site this request belongs to. requestId is opaque and site-local, so an agent
   * holding conversations with two sites at once sees two indistinguishable `req-...`
   * strings. Nothing is exploitable — hand one site the other's id and it answers "no
   * pending request" — but the agent cannot TELL them apart, and neither can anyone
   * reading a transcript. The pair (origin, requestId) is what identifies a request.
   *
   * Deliberately a separate field rather than a prefix baked into requestId: the id is
   * echoed into human-facing text and run through sanitizeRequestId, which strips
   * anything outside [A-Za-z0-9_-] — so a hostname folded into it would be shown to the
   * agent in a different form than the one it must send back.
   */
  origin?: string;
  requestId: string;
  /** For the PERSON. Safe to relay verbatim; carries no instruction to the agent. */
  message: string;
  /** For the AGENT. Never read aloud. Omitted when there is nothing useful to say. */
  agentHint?: string;
}

export function needsConfirmationResult(
  reason: string, requestId: string,
  extra: { agentHint?: string; origin?: string } = {},
): ConfirmationNeededResult {
  return {
    ok: false, needsHumanConfirmation: true, requestId, message: reason,
    ...(extra.origin ? { origin: extra.origin } : {}),
    ...(extra.agentHint ? { agentHint: extra.agentHint } : {}),
  };
}
