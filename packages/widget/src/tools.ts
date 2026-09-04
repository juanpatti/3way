import type { Bus } from './bus';
import { checkGate, needsConfirmationResult } from './gates';
import { evaluateOrderChange, evaluateRecordsRelease, evaluateReturnEligibility } from './eligibility';
import { RETURN_REASONS, isReturnReason } from './types';
import { validateAddress } from './address';
import type {
  CallContext, LogEntry, Order, PendingRequest, Policy, Product, RequestKind, ReturnReason, Tool,
} from './types';

export interface DataSource {
  listOrders(): Promise<Order[]>;
  getOrder(orderId: string): Promise<Order | null>;
  searchProducts(query: string): Promise<Product[]>;
  getProduct(sku: string): Promise<Product | null>;
}

/**
 * What the shared gateway needs, and nothing more. Split out from ToolDeps so a domain
 * with a different data source — the clinic has visits, not orders — can build on the
 * same machinery without pretending to have a catalogue.
 */
export interface GatewayDeps {
  bus: Bus;
  policy: Policy;
  now: () => number;
  newRequestId: () => string;
  /**
   * Performs a consequential action server-side, where the authoritative gate lives.
   * The strong path sends exactly `{ tool, requestId, token }` — no eligibility triple or
   * deviceId. The Worker reads the subject from the token record minted before the
   * ceremony. The optional PendingRequest exists only for the deliberately tokenless
   * demo-weak path; it stays visibly untrusted and reaches the same Worker binder and
   * executor instead of creating a second implementation.
   */
  act(
    tool: string, requestId: string, token: string | null, weakSubject?: PendingRequest,
  ): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }>;
  /** Fired when a gated tool is blocked, so the UI can offer the human a confirm affordance. */
  onConfirmationNeeded?: (req: PendingRequest, tool: string) => void;
  /**
   * This site's origin, stamped onto refusals so an agent in more than one conversation
   * can tell whose requestId it is holding (see ConfirmationNeededResult.origin). Optional
   * so a test can construct tools without a DOM; mount() always supplies location.origin.
   */
  siteOrigin?: string;
  /**
   * How long a gated action holds a NON-terminal answer open for the visiting agent — the
   * refusal, or the "still completing" state — before returning it. The agent that asked
   * "complete this return" is then still on the line when the person confirms, and gets
   * the completed receipt from the call it already made, instead of having to decide to
   * call await_reply. Measured live: told to call await_reply in the agentHint, the agent
   * ended its turn anyway; the person confirmed, the refund ran, and nobody was listening.
   * The instruction was a prompt; this is the mechanism.
   *
   * 0 (the default) returns at once. mount() passes DEFAULT_HOLD_MS; nothing else opts in.
   * Off by default because every gated-tool fixture in the test suite expects an
   * immediate refusal, and one (records-release) resolves its act promise only AFTER
   * awaiting the agent's poll — a default hold would deadlock it.
   */
  holdMs?: number;
  /** Fired when a gated call starts holding, so the UI can say the agent is waiting. */
  onHold?: (requestId: string, tool: string) => void;
}

/** The shop's dependencies: the gateway's, plus a catalogue to read. */
export interface ToolDeps extends GatewayDeps {
  data: DataSource;
}

/**
 * What an agent is allowed to see of a log entry. `fromHuman` means the entry arrived
 * through the human-direct ingress path — it is NOT a cryptographic guarantee (origin
 * alone is forgeable by anything with code execution in this page; see bus.ts), so it
 * must never be spelled "verified" here.
 */
export function publicEntry(e: LogEntry) {
  return { origin: e.origin, text: e.text, fromHuman: e.origin === 'human-direct' };
}

const obj = (props: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties: props, required } as Record<string, unknown>);
const str = (description: string) => ({ type: 'string', description });
/**
 * One array, one enum — the schema an agent reads can never list codes the engine rejects.
 *
 * The per-code guidance is not decoration. Observed live: "the lamp arrived with a cracked
 * base" was sent as 'damaged-in-transit', which is bound by the 30-day window and therefore
 * DENIED, when the same facts as 'defect' are a warranty claim exempt from it. Both agents
 * read this string, and it is the only place the difference between the two is stated at
 * the point of choosing.
 */
const reasonProp = {
  type: 'string', enum: [...RETURN_REASONS],
  description:
    'Why the item is coming back. Pick by what the customer actually described, and do not ' +
    'reason about the policy consequences — that is what the verdict is for. ' +
    'defect: the item itself is faulty or arrived broken, with nothing said about the parcel ' +
    'or the courier — a cracked, dead, or misbehaving item is this one. ' +
    'damaged-in-transit: the customer described damage to the shipment — a crushed box, ' +
    'torn packaging, a courier incident. Do not choose this merely because the item is ' +
    'broken; it needs something said about the shipping. ' +
    'wrong-item: we shipped something other than what was ordered. ' +
    'changed-mind: nothing is wrong with it.',
};

/**
 * The line id INSIDE an order, which is not any of the three identifiers a model is more
 * likely to have to hand (the SKU, the product title, the order id). Observed live: the
 * store agent passed a SKU here, got "Item SKU-STD-001 is not part of order ORD-1043", and
 * relayed that to the customer as a mix-up with their order.
 */
const itemIdProp = str(
  'The id of the line within the order — the `itemId` field returned by get_order_status ' +
  'or list_my_orders, e.g. "IT-1". Call one of those first if you do not have it. This is ' +
  'not the SKU and not the product title.');

/**
 * How each request kind is named in a refusal, and which tool files one. The article is
 * carried alongside the noun because these strings are read by a model that then relays
 * them to a person — "a address change" is the kind of seam that makes a careful refusal
 * read like a template.
 */
const KIND: Record<RequestKind, { article: string; noun: string; filedBy: string }> = {
  'return': { article: 'a', noun: 'return', filedBy: 'request_return' },
  'cancel': { article: 'a', noun: 'cancellation', filedBy: 'request_cancel' },
  'address-change': { article: 'an', noun: 'address change', filedBy: 'request_address_change' },
  'records-release': { article: 'a', noun: 'records release', filedBy: 'request_records_release' },
  'disclosure': { article: 'a', noun: 'records disclosure', filedBy: 'request_records_disclosure' },
};
const aKind = (k: RequestKind) => `${KIND[k].article} ${KIND[k].noun}`;

/**
 * await_reply's bounds. The default sits under the tool-call timeout most agent runtimes
 * impose, so a quiet conversation returns "nothing new" on our terms rather than erroring
 * on theirs.
 */
const DEFAULT_WAIT_MS = 25_000;
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 30_000;
/**
 * How long a gated action holds the line for the visiting agent (GatewayDeps.holdMs).
 * The same figure as await_reply's default, for the same reason: it is a bet that the
 * agent runtime's own tool-call timeout is longer. That timeout is NOT measured in this
 * repo — docs/probe/index.html's probe_slow is the instrument, and it has to be run in
 * the runtime that will actually visit. If this exceeds it, every held call becomes a
 * runtime error, which is strictly worse than the refusal it replaces.
 */
export const DEFAULT_HOLD_MS = DEFAULT_WAIT_MS;

type TerminalOutcome = 'completed' | 'refused' | 'indeterminate';
type ReceiptStatus = 'available' | 'consumed' | 'expired' | 'evicted' | 'unavailable';

/**
 * Two deliveries, rather than one, let the filing agent retry once when the first tool
 * response is lost after this gateway returned it. Deleting on the first read caused the
 * exact stranded-agent failure this cache exists to prevent; retaining beyond the retry
 * would expose account or medical records more times than that failure requires.
 */
const RECEIPT_DELIVERIES = 2;
/**
 * Five minutes covers await_reply's 30-second windows and several ordinary retry turns,
 * while preventing an agent that disappears after filing from leaving account records or
 * medical documents resident for the widget's entire lifetime.
 */
const RECEIPT_TTL_MS = 5 * 60_000;
/**
 * Sixty-four unread payloads is far above a real conversation's pending actions but caps
 * the failure where repeated filings retain an unbounded collection of records in memory.
 */
const MAX_RECEIPTS = 64;
/**
 * Tombstones outlive payloads so a stranded filer gets an honest terminal status after a
 * receipt expires. Thirty minutes bounds the separate failure where request ids and status
 * metadata otherwise accumulate for the whole gateway lifetime.
 */
const TOMBSTONE_TTL_MS = 30 * 60_000;
/**
 * Tombstones carry no action payload, but hostile repeated filings could still grow their
 * metadata without limit. This cap bounds that failure independently of the tighter limit
 * on sensitive receipts.
 */
const MAX_TOMBSTONES = 256;

interface RetainedReceipt {
  /** See PendingRequest.requestedBy: one consumer per ingress surface in this gateway. */
  consumer: CallContext['origin'];
  payload: Record<string, unknown>;
  deliveries: number;
  expiresAt: number;
}

/** Payload fields never belong here; this is the non-sensitive state left after removal. */
interface TerminalTombstone {
  origin: string;
  requestId: string;
  outcome: TerminalOutcome;
  receiptStatus: ReceiptStatus;
  expiresAt: number;
}

export type ToolRegistry = Tool[] & { destroy(): void };

export function withGatewayDestroy(tools: Tool[], destroy: () => void): ToolRegistry {
  // The registry owns the gateway maps, so its lifecycle method is production cleanup,
  // not a test hook. Keeping it non-enumerable prevents array consumers from mistaking
  // destroy for another tool while mount() can still clear retained records on teardown.
  Object.defineProperty(tools, 'destroy', { value: destroy, enumerable: false });
  return tools as ToolRegistry;
}

/**
 * Everything a domain does NOT have to reinvent: the pending-request store, the gated
 * action wrapper, and the read-only annotation.
 *
 * Pulled out because a second domain exists. A clinic has visits and records, not orders
 * and refunds, and naming its tools list_my_orders to reuse this file would be a lie
 * dressed as reuse. What genuinely IS shared is the machinery underneath — one shared
 * transcript, stamped origins, a refusal shape, and a gate that only a person can pass —
 * and that is what makes the gateway reusable across domains. Two domains over one
 * gateway demonstrate the boundary directly.
 */
export function createGateway(deps: GatewayDeps) {
  const { bus, policy, act, onConfirmationNeeded, siteOrigin } = deps;
  const pending = new Map<string, PendingRequest>();
  const attempts = new Set<string>();
  const receipts = new Map<string, RetainedReceipt>();
  const tombstones = new Map<string, TerminalTombstone>();
  const origin = siteOrigin ?? 'unknown-origin';
  let destroyed = false;

  /**
   * Consequential actions that have already completed, keyed by (kind, orderId, itemId).
   * Read by the request_* tools so a second return cannot be FILED for an order already
   * returned in this session. Found on camera: after a refund completed, the agent called
   * request_return again for the same order; nothing recorded the first return, so
   * evaluateReturnEligibility still said eligible (a warranty defect is window-exempt), a
   * fresh confirm box appeared, and confirming it would have refunded ORD-1043 twice.
   *
   * In memory and per gateway instance ON PURPOSE: it must reset on reload so the seeded
   * demo re-runs. No SERVER-side marker backs this up, deliberately: keyed on the stable
   * seeded (orderId, itemId) it would outlive a reload and refuse a filmed rerun AFTER the
   * hardware gesture — the widget/Worker policy disagreement that is the worst
   * failure to debug. Nor is one needed: a genuine second refund would take a second full
   * ceremony — a human-direct confirmation carrying its own WebAuthn assertion and a fresh
   * single-use token — which is the person choosing to confirm twice, not a silent
   * double-spend. This guard's whole job is to stop the second confirm box from ever being
   * raised. The three parts are space-joined, and no seed orderId or
   * itemId contains a space, so distinct pairs cannot collide into one key.
   */
  const completed = new Set<string>();
  const completedKey = (kind: RequestKind, orderId: string, itemId: string) =>
    [kind, orderId, itemId].join(' ');

  /**
   * Why a held call resumed. 'terminal' is the one that matters: the person confirmed and
   * the human-direct path finished the action, so the receipt is there to read. 'spoke' is
   * the person saying something OTHER than yes — that is an answer too, and the agent
   * should see it now rather than after the window. The rest are housekeeping.
   */
  type HoldOutcome = 'terminal' | 'spoke' | 'timeout' | 'superseded' | 'destroyed';
  const holdMs = typeof deps.holdMs === 'number' && Number.isFinite(deps.holdMs) && deps.holdMs > 0
    ? deps.holdMs : 0;
  // One hold per (tool, requestId), never two. Runtimes reissue calls, and a re-arm after a
  // runtime-side timeout can land while the page still holds the first one; two holds
  // waking on one terminal would each read the receipt and burn BOTH deliveries — the
  // agent's one lost-response retry gone before it was ever needed. A newer call takes
  // over the wait and the older one resumes with a refusal saying so.
  const holds = new Map<string, (why: HoldOutcome) => void>();
  const hold = (key: string, requestId: string, tool: string) => new Promise<HoldOutcome>(resolve => {
    holds.get(key)?.('superseded');
    let done = false;
    const settle = (why: HoldOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      if (holds.get(key) === settle) holds.delete(key);
      resolve(why);
    };
    // The bus is watched for the PERSON only. The store agent's commentary rides back on
    // room_since_last_call whenever this returns; it is not an answer to a pending
    // confirmation. A human-direct entry that carries `confirms` is a confirmation — of
    // this request (the terminal follows within one round trip, and finish() below is
    // what resumes us) or of another one (not our business) — so neither ends the wait.
    // Deliberately NOT how the terminal is detected: the completion line is itself a
    // site-agent entry, and a hold that filtered on origin would sleep through it.
    const unsubscribe = bus.subscribe(e => {
      if (e.origin !== 'human-direct') return;
      if (e.confirms !== undefined) return;
      settle('spoke');
    });
    const timer = setTimeout(() => settle('timeout'), holdMs);
    holds.set(key, settle);
    deps.onHold?.(requestId, tool);
  });

  const attemptKey = (tool: string, requestId: string) => `${tool}:${requestId}`;

  const prune = () => {
    const at = deps.now();
    for (const [key, receipt] of receipts) {
      if (receipt.expiresAt > at) continue;
      receipts.delete(key);
      const tombstone = tombstones.get(key);
      if (tombstone) tombstone.receiptStatus = 'expired';
    }
    for (const [key, tombstone] of tombstones) {
      if (tombstone.expiresAt > at) continue;
      tombstones.delete(key);
      receipts.delete(key);
    }
  };

  const retainTerminal = (
    key: string, req: PendingRequest, outcome: TerminalOutcome,
    payload: Record<string, unknown>,
  ) => {
    if (destroyed) return;
    prune();
    while (tombstones.size >= MAX_TOMBSTONES) {
      const oldest = tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      tombstones.delete(oldest);
      receipts.delete(oldest);
    }
    const retainPayload = req.requestedBy !== undefined && req.requestedBy !== 'human-direct';
    const tombstone: TerminalTombstone = {
      origin, requestId: req.requestId, outcome,
      receiptStatus: retainPayload ? 'available' : 'unavailable',
      expiresAt: deps.now() + TOMBSTONE_TTL_MS,
    };
    // The tombstone is deliberately created from metadata field-by-field. Never spread
    // payload here: after consumption/expiry this object is what remains, and a spread
    // would strand account records, medical documents, or an address in the "safe" map.
    tombstones.set(key, tombstone);
    if (!retainPayload) return;

    while (receipts.size >= MAX_RECEIPTS) {
      const oldest = receipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      receipts.delete(oldest);
      const evicted = tombstones.get(oldest);
      if (evicted) evicted.receiptStatus = 'evicted';
    }
    receipts.set(key, {
      consumer: req.requestedBy!, payload, deliveries: 0,
      expiresAt: deps.now() + RECEIPT_TTL_MS,
    });
  };

  const tombstoneResult = (tombstone: TerminalTombstone, status = tombstone.receiptStatus) => ({
    // `ok` continues to describe the action's known outcome, not whether this poll carries
    // its payload. Stamping a completed-but-consumed result false made an older consumer
    // infer the action never happened — the same dishonest status tombstones prevent.
    ok: tombstone.outcome === 'completed',
    terminal: true as const,
    outcome: tombstone.outcome,
    receiptStatus: status,
    origin: tombstone.origin,
    requestId: tombstone.requestId,
    message:
      `Request ${tombstone.requestId} was filed and reached terminal status ` +
      `${tombstone.outcome}. Its retained result is ${status}; no payload is included.`,
    agentHint:
      'This is a terminal status, not permission to execute the action. Do not retry the action; ' +
      'check the current order or release status if more detail is needed.',
  });

  const readTerminal = (key: string, consumer: CallContext['origin']) => {
    prune();
    const tombstone = tombstones.get(key);
    if (!tombstone) return undefined;
    const receipt = receipts.get(key);
    if (!receipt || receipt.consumer !== consumer) {
      return tombstoneResult(tombstone, receipt ? 'unavailable' : tombstone.receiptStatus);
    }
    const payload = receipt.payload;
    receipt.deliveries += 1;
    if (receipt.deliveries >= RECEIPT_DELIVERIES) {
      // Drop the sensitive object itself after the one lost-response retry. The tombstone
      // retains only terminal metadata, so a third read cannot recover records or addresses.
      receipts.delete(key);
      tombstone.receiptStatus = 'consumed';
    }
    return payload;
  };

  const destroy = () => {
    destroyed = true;
    // A hold left behind would resolve up to a window later into an aborted registration.
    for (const settle of [...holds.values()]) settle('destroyed');
    holds.clear();
    pending.clear();
    attempts.clear();
    receipts.clear();
    tombstones.clear();
    completed.clear();
  };

  const ro = { readOnlyHint: true };

  /**
   * Shared body for the three gated actions. `description` and `completion` are
   * deliberately separate strings: `description` is what an agent reads to decide
   * whether/how to call the tool (long, explanatory), `completion` is what gets appended
   * to the shared transcript once the server has actually confirmed the action ran
   * (short, a status line a person would read). They used to be the same string — the
   * transcript's peak moment logged the tool's full description read aloud instead of a
   * plain "done" line.
   */
  const gated = (name: string, kind: RequestKind, description: string, completion: string): Tool => {
    /**
     * Re-entrant on purpose. A first pass that would hand the visiting agent a
     * non-terminal answer holds instead, then runs the SAME body a second time with
     * `held` set: the terminal read at the top yields the receipt if the person finished,
     * and every other branch yields exactly what it always did, with the agentHint saying
     * what the wait found. No second set of return shapes exists to drift.
     */
    const run = async (
      input: Record<string, unknown>, ctx: CallContext, held: HoldOutcome | null,
    ): Promise<unknown> => {
      const requestId = String(input.requestId ?? '');
      const key = attemptKey(name, requestId);
      // An exact allowlist, not `!== 'site-agent'`. The site agent's call is awaited
      // inside a live Realtime turn (session.ts) and a 25-second wait there is the
      // person watching their store's agent say nothing; the human path is the executor;
      // and an origin this union does not yet name must not fall into a wait by default.
      const canHold = held === null && holdMs > 0 && !destroyed
        && (ctx.origin === 'agent-autonomous' || ctx.origin === 'agent-relay');
      const holdNote = (inFlight: boolean): string => {
        const s = Math.round(holdMs / 1000);
        switch (held) {
          case 'timeout': return inFlight
            ? `Waited ${s}s; the confirmation is recorded and ${name} is still completing. ` +
              `Call ${name} again with the same requestId — it waits for the result and never repeats the action.`
            : `Waited ${s}s and the customer has not confirmed yet; nothing has been actioned. ` +
              `Call ${name} again with the same requestId to keep waiting for them — that call reads ` +
              `state and never repeats the action. Do not end your turn while they are still deciding.`;
          case 'spoke':
            return `The customer said something instead of confirming — it is in room_since_last_call; ` +
              `answer them. Nothing has been actioned. Call ${name} again with the same requestId ` +
              `when they are ready; it will wait for them again.`;
          case 'superseded':
            return `A newer call for this request took over the wait; use that call's result.`;
          default:
            return `Nothing has been actioned. Call ${name} again with the same requestId to check.`;
        }
      };
      const terminal = readTerminal(key, ctx.origin);
      if (terminal) {
        // This is a receipt read, not a second authorization path. It occurs before the
        // pending lookup, gate, token lookup and executor, and can therefore neither re-run
        // the action nor resurrect a spent request. readTerminal checks the filing origin,
        // so the site agent cannot drain a visiting agent's payload (or vice versa).
        return terminal;
      }
      const awaiting = () => ({
        ok: false as const,
        awaitingHumanExecution: true as const,
        terminal: false as const,
        origin,
        requestId,
        message: `The confirmation is recorded and ${name} is still completing in the widget.`,
        agentHint: held !== null
          ? `This response is not terminal. Do not attempt to execute ${name}. ${holdNote(true)}`
          : `This response is not terminal. Do not attempt to execute ${name}. Call await_reply, ` +
            `then poll ${name} with the same requestId until terminal is true. Agent-origin polls ` +
            `only read state; they never spend the confirmation.`,
      });
      if (attempts.has(key)) {
        // The pending entry is removed before the network call so a lost response cannot
        // be retried. Keep a separate non-authorizing marker only to tell concurrent
        // callers the truth: this is already in flight. It carries no token or result and
        // never reaches the gate or executor, so it cannot become a second action path.
        if (canHold) return run(input, ctx, await hold(key, requestId, name));
        return awaiting();
      }
      const req = pending.get(requestId);
      if (!req) {
        // The empty-id case reads as a bug report otherwise ("No pending request ."), and
        // it is the single likeliest way to arrive here: an agent that never filed
        // anything and called the action tool directly. Say what to call instead.
        return { ok: false, message: requestId
          ? `No pending request or retained result exists for ${requestId}. It may not have ` +
            `been filed here, or its bounded terminal state may have expired. Call ` +
            `${KIND[kind].filedBy} only to start a new request.`
          : `${name} needs the requestId of a pending ${KIND[kind].noun} request. ` +
            `Call ${KIND[kind].filedBy} first.` };
      }

      // One request, one kind of action. A cancellation the person confirmed must not be
      // spendable as a refund — the gate below binds a confirmation to a TOOL name, but
      // nothing stopped an agent from handing a return's id to cancel_order and having
      // the returns verdict answer for a cancellation. Checked before the eligibility and
      // gate checks so a wrong-kind call never raises a confirm box at the person.
      if (req.kind !== kind) {
        return { ok: false, requestId, message:
          `Request ${requestId} is not ${aKind(kind)} request — it was filed by ` +
          `${KIND[req.kind].filedBy} as ${aKind(req.kind)}. Call ${KIND[kind].filedBy} ` +
          `to file ${aKind(kind)} for this order.` };
      }

      // A request that was never eligible can never be completed, no matter what the
      // human confirms — confirming authorizes acting on the claim, not overriding the
      // policy verdict. Checked before the gate so an ineligible request is refused even
      // if it is somehow already confirmed, and before `act` so nothing gets appended to
      // the transcript claiming a denied claim was completed.
      if (!req.eligibility.eligible) {
        return {
          ok: false, requestId, eligibility: req.eligibility,
          message: `Request ${requestId} was evaluated as not eligible (${req.eligibility.path}): ` +
            req.eligibility.because.join(' '),
        };
      }

      // Advisory check: refuse fast and legibly, and raise the confirm affordance.
      // Tool-bound: a confirmation minted for confirm_return must not also satisfy
      // cancel_order or change_address: one confirmation authorizes one action.
      const gate = checkGate(name, requestId, bus, policy.rules);
      if (!gate.ok) {
        // Raised once per call, not once per pass: the box is already up when a held
        // call resumes (and modal.requestConfirmation is idempotent for it regardless).
        if (held === null) onConfirmationNeeded?.(req, name);
        // Hold the line HERE, with the box on screen, so the person's confirmation is
        // answered by the call that asked for it. The refusal below is what the agent gets
        // if the window closes first — the same shape as ever, with a hint that says so.
        if (canHold) return run(input, ctx, await hold(key, requestId, name));
        const receiptHint = ctx.origin === 'site-agent'
          ? `After the confirmation completes, call ${name} again with the same requestId ` +
            `to poll its retained terminal result. That call reads state; it does not repeat the action.`
          : held !== null
            ? holdNote(false)
            : `${gate.agentHint ?? ''} After await_reply reports the completion, call ${name} ` +
              `again with the same requestId to poll its retained terminal result. ` +
              `That call reads state; it does not repeat the action.`;
        return needsConfirmationResult(gate.reason, requestId,
          { agentHint: receiptHint.trim(), origin: siteOrigin });
      }

      if (ctx.origin !== 'human-direct') {
        // A confirmation appearing on the shared bus is not permission for an agent to
        // become the executor. Without this stop, an agent racing the widget after the
        // confirmation entry landed could call /api/act itself and receive sensitive
        // records before the human path populated its origin-bound receipt. Agents may
        // read a completed receipt above; only the human-direct click path may spend.
        if (canHold) return run(input, ctx, await hold(key, requestId, name));
        return awaiting();
      }

      // Authoritative check: the Worker re-validates the single-use token before acting,
      // and rejects it if it was not issued for this tool. If this page were patched to
      // skip the check above, this call still fails.
      // Never throw across a tool boundary. A lost response is the awkward
      // case: the Worker may have burned the token and acted, and we cannot tell. Say so
      // rather than implying nothing happened.
      // Delete before the call crosses the network. A response can be lost after the
      // Worker acted, and leaving this pending entry beside the still-visible token made
      // the terminal "do not retry" warning false: a later caller could invoke act again.
      // The local request is terminal once its one authorized attempt begins, regardless
      // of whether the response comes back success, refusal, or indeterminate.
      attempts.add(key);
      pending.delete(requestId);
      const finish = (
        result: Record<string, unknown>, outcome: TerminalOutcome, eventText: string,
      ) => {
        // Store the pollable terminal state before waking await_reply. Appending first let
        // a waiter resume in the gap and receive the old "no pending request" response.
        retainTerminal(key, req, outcome, result);
        // Record the subject as done so a re-filed request for it cannot raise a second
        // box (see `completed`). Only a genuine completion counts — an indeterminate or
        // refused outcome leaves the subject open, because the action may not have run.
        if (outcome === 'completed') {
          completed.add(completedKey(req.kind, req.orderId, req.itemId ?? ''));
        }
        attempts.delete(key);
        // Resume the held call AFTER the receipt exists and before anything else can run:
        // its continuation is a microtask, so by the time it re-reads state the completion
        // line below is on the bus too and rides back with the receipt. Direct, not via
        // the bus: the line is a site-agent entry, which the hold deliberately ignores, and
        // a destroyed gateway appends nothing at all.
        holds.get(key)?.('terminal');
        if (!destroyed) {
          bus.append({ origin: 'site-agent', text: eventText, authoredByTool: true });
        }
        return result;
      };
      let server: { ok: boolean; error?: string; data?: Record<string, unknown> } | undefined;
      try {
        const token = bus.confirmationToken(requestId, name);
        // The strong path sends no client subject at act time: the Worker reads it from
        // the token record minted before the ceremony. Only the deliberately weak demo
        // path has no record, so it sends the already displayed PendingRequest for the
        // shared binder/executor while remaining honestly forgeable.
        server = token
          ? await act(name, requestId, token)
          : await act(name, requestId, token, req);
      } catch {
        return finish({
          ok: false, terminal: true, outcome: 'indeterminate', origin, requestId,
          message: `Could not reach the server to complete ${name}. It may or may not have gone through.`,
          agentHint: 'The request is terminal locally. Do not retry; check the order or release status first.',
        }, 'indeterminate',
        `The outcome of ${name} is indeterminate. The request is terminal locally; no sensitive result is included.`);
      }
      if (!server) {
        return finish({
          ok: false, terminal: true, outcome: 'indeterminate', origin, requestId,
          message: `The server returned no stamped outcome for ${name}. It may or may not have gone through.`,
          agentHint: 'The request is terminal locally. Do not retry; check the order or release status first.',
        }, 'indeterminate',
        `The outcome of ${name} is indeterminate. The request is terminal locally; no sensitive result is included.`);
      }
      if (!server.ok) {
        return finish({
          ok: false, terminal: true, outcome: 'refused', origin, requestId,
          message: `Refused by the server: ${server.error ?? 'no reason given'}.`,
          agentHint: 'The refusal is terminal. Do not retry this request.',
        }, 'refused',
        `The server refused ${name}. The request is terminal; no sensitive result is included.`);
      }

      // authoredByTool: the model did not write this line, so it must be fed back into the
      // session as context — see LogEntry.authoredByTool.
      // Do not echo the address here: bus entries are relayed to third-party models, and
      // Relay prose must not expose personal data. The exact address remains in
      // the local confirm box and the server result rendered by the widget.
      // `data` is whatever the Worker chose to hand back for this action, and for
      // disclose_order_records it IS the action: the records do not exist in this page
      // until a server-issued action token has been spent for them. Owned stamped fields
      // are spread last so malformed server data cannot turn a completed result into `ok:false` or
      // relabel which request the gate actually spent.
      const result = {
        ...(server.data ?? {}), ok: true, terminal: true, outcome: 'completed', origin,
        requestId, orderId: req.orderId, path: req.eligibility.path,
      };
      return finish(result, 'completed', `${completion} Completed for ${req.orderId}.`);
    };
    return {
      name,
      description:
        `${description} This is a consequential action. It only succeeds after the customer ` +
        `confirms it themselves in the widget — you cannot confirm on their behalf.`,
      inputSchema: obj(
        { requestId: str(`The id returned by ${KIND[kind].filedBy}.`) }, ['requestId']),
      execute: (input, ctx) => run(input, ctx, null),
    };
  };

  /** Whether a consequential action of this kind already completed for this subject. */
  const hasCompleted = (kind: RequestKind, orderId: string, itemId: string) =>
    completed.has(completedKey(kind, orderId, itemId));

  return { pending, gated, ro, destroy, hasCompleted };
}

/** The shop's registry: the shared gateway plus tools that only make sense in a shop. */
export function createTools(deps: ToolDeps): ToolRegistry {
  const { bus, data, policy, now, newRequestId, onConfirmationNeeded } = deps;
  const { pending, gated, ro, destroy, hasCompleted } = createGateway(deps);

  const tools: Tool[] = [
    {
      name: 'search_products', description: 'Search the catalogue.', annotations: ro,
      activity: 'searched the catalogue',
      inputSchema: obj({ query: str('Free text search.') }, ['query']),
      execute: async i => ({ products: await data.searchProducts(String(i.query ?? '')) }),
    },
    {
      name: 'get_product', description: 'Fetch one product by SKU.', annotations: ro,
      activity: 'looked up a product',
      inputSchema: obj({ sku: str('Product SKU.') }, ['sku']),
      execute: async i => ({ product: await data.getProduct(String(i.sku ?? '')) }),
    },
    {
      name: 'list_my_orders', description: "List the signed-in customer's orders.", annotations: ro,
      activity: 'looked up your orders',
      inputSchema: obj({}),
      execute: async () => ({ orders: await data.listOrders() }),
    },
    {
      name: 'get_order_status', description: 'Status and contents of one order.', annotations: ro,
      activity: 'opened an order',
      inputSchema: obj({ orderId: str('Order id.') }, ['orderId']),
      execute: async i => ({ order: await data.getOrder(String(i.orderId ?? '')) }),
    },
    {
      name: 'get_policy', description: 'The full returns and warranty policy text.', annotations: ro,
      activity: 'read the returns policy',
      inputSchema: obj({}),
      execute: async () => ({ policy: policy.prose }),
    },
    {
      name: 'get_conversation',
      description: 'The conversation so far, with who said each line.', annotations: ro,
      inputSchema: obj({}),
      execute: async () => ({ entries: bus.all().map(publicEntry) }),
    },
    {
      name: 'evaluate_return_eligibility',
      activity: 'checked the returns policy',
      description:
        'Authoritative verdict on whether an item can be returned, and by which route. ' +
        'Always call this instead of reasoning about the policy yourself.',
      annotations: ro,
      inputSchema: obj({
        orderId: str('Order id.'), itemId: itemIdProp,
        reason: reasonProp,
      }, ['orderId', 'itemId', 'reason']),
      async execute(i) {
        const order = await data.getOrder(String(i.orderId ?? ''));
        if (!order) return { eligible: false, path: 'denied', because: ['Unknown order.'] };
        // An item already returned this session is no longer returnable, whatever the
        // policy clauses say — a warranty defect is window-exempt, so the pure engine
        // keeps saying "eligible" for an order that has in fact been refunded. Layered
        // here, not inside evaluateReturnEligibility, which stays pure and is the Worker's
        // too — injecting session state into it would force a cross-session server marker
        // that breaks re-running the seeded demo (see `completed` above).
        if (hasCompleted('return', order.orderId, String(i.itemId ?? ''))) {
          return { eligible: false, path: 'denied',
            because: [`Order ${order.orderId} item ${String(i.itemId ?? '')} has already been returned and refunded.`] };
        }
        // The cast is gone on purpose: an unrecognised code is rejected inside
        // evaluateReturnEligibility and comes back as a denial that says so, rather than
        // being asserted into the union and answered as change-of-mind.
        return evaluateReturnEligibility(
          order, String(i.itemId ?? ''), i.reason as ReturnReason, policy.rules, now());
      },
    },
    {
      name: 'send_message',
      description:
        'Add a message to the shared exchange. The person and the service can see it. ' +
        'Set intent to "relay" only when passing on what the person said; otherwise ' +
        'the message is attributed to the visiting agent speaking for itself.',
      inputSchema: obj({
        text: str('What to say.'),
        intent: { type: 'string', enum: ['relay', 'own'], description: 'Defaults to "own".' },
      }, ['text']),
      async execute(i, ctx) {
        // Scoped away from the site agent, but defend in depth: it must never be able to
        // append messages attributed to the visitor, which would also re-enter its own
        // response loop (see session.ts).
        if (ctx.origin === 'site-agent') {
          return { ok: false, message: 'send_message is not available to the store agent.' };
        }
        // An agent can never claim human-direct: only these two origins are reachable here.
        const origin = i.intent === 'relay' ? 'agent-relay' : 'agent-autonomous';
        const entry = bus.append({ origin, text: String(i.text ?? '') });
        // Said at the one moment it is actionable. A tool description is read once, in
        // the abstract; this is read immediately after doing the thing that makes a reply
        // likely, which is when the model is actually deciding what to do next.
        return {
          ok: true, id: entry.id,
          hint: 'A reply will not be pushed to you. Call await_reply to wait for it.',
        };
      },
    },
    {
      name: 'provide_context',
      description:
        'Front-load what you already know about the customer and their problem, so the ' +
        'store does not have to ask. Call this first, before anything else.',
      inputSchema: obj({
        summary: str('One or two sentences on what the customer wants.'),
        data: { type: 'object', description: 'Structured facts: orderId, dates, what was tried.' },
      }, ['summary']),
      async execute(i, ctx) {
        // Same guard as send_message, and for the same reason: if scoping is ever
        // bypassed, this must not become the open door that lets the store's own agent
        // append context attributed to the visitor and re-enter its own response loop.
        if (ctx.origin === 'site-agent') {
          return { ok: false, message: 'provide_context is not available to the store agent.' };
        }
        bus.append({
          origin: 'agent-autonomous',
          text: String(i.summary ?? ''),
          context: (i.data ?? {}) as Record<string, unknown>,
        });
        return { ok: true };
      },
    },
    {
      name: 'request_return',
      activity: 'filed a return request',
      description:
        'Propose a return or warranty claim. Always allowed — this only creates a pending ' +
        'request and tells you whether it qualifies. It does not move any money.',
      inputSchema: obj({
        orderId: str('Order id.'), itemId: itemIdProp,
        reason: reasonProp,
      }, ['orderId', 'itemId', 'reason']),
      async execute(i, ctx) {
        const order = await data.getOrder(String(i.orderId ?? ''));
        if (!order) return { ok: false, message: 'Unknown order.' };
        // Already returned this session: file nothing and raise no box. Found on camera —
        // after a refund completed, the agent re-filed for the same order, a second
        // confirm box appeared, and confirming it would have refunded twice (the pure
        // eligibility engine keeps saying a warranty defect qualifies). Nothing is stored,
        // and onConfirmationNeeded is never called, so no affordance is offered — which is
        // the whole fix: a genuine second refund would need a second full ceremony, and
        // this stops the box that would invite one.
        if (hasCompleted('return', order.orderId, String(i.itemId ?? ''))) {
          return { ok: false, message:
            `Order ${order.orderId} item ${String(i.itemId ?? '')} has already been returned and ` +
            `refunded. There is nothing left to confirm; do not file it again.` };
        }
        // Refused here rather than filed with a bad code: a pending request is a thing a
        // person can be asked to confirm, and one built on a reason the engine could not
        // read is a confirmation prompt for a verdict nobody computed. Nothing is stored.
        if (!isReturnReason(i.reason)) {
          return { ok: false, message:
            `"${String(i.reason)}" is not a return reason this policy recognises. ` +
            `Use one of: ${RETURN_REASONS.join(', ')}.` };
        }
        const reason = i.reason;
        const eligibility = evaluateReturnEligibility(
          order, String(i.itemId ?? ''), reason, policy.rules, now());
        const requestId = newRequestId();
        const req: PendingRequest = {
          requestId, kind: 'return', orderId: order.orderId,
          itemId: String(i.itemId ?? ''), reason, requestedBy: ctx.origin, eligibility,
        };
        pending.set(requestId, req);
        // Raise the confirm affordance as soon as an ELIGIBLE request exists, rather than
        // waiting for someone to attempt confirm_return and be refused. Observed live:
        // the visiting agent filed an eligible warranty claim, the store agent correctly
        // told the customer to confirm it themselves — and there was nothing on screen to
        // confirm with, because the only thing that had ever raised the modal was a
        // REFUSED gated call. Being told to act with no control to act through reads as a
        // broken page, and it is the last step before money moves.
        //
        // Deliberately not raised for an ineligible request: a denied claim has nothing to
        // confirm, and popping a confirmation over a refusal would invite exactly the
        // "click past the policy" reading this design exists to refuse. The affordance is
        // only an affordance — the real authorization still runs the full ceremony, and
        // the Worker still re-checks eligibility against the token it minted.
        if (eligibility.eligible) onConfirmationNeeded?.(req, 'confirm_return');
        return { ok: true, requestId, eligibility };
      },
    },
    /**
     * The cancel/redirect counterparts of request_return. Without these, cancel_order and
     * change_address were registered but unreachable: both took a requestId documented as
     * coming from request_return, so the only id an agent could hand them belonged to a
     * RETURN, and their gate then judged a cancellation by the returns policy.
     */
    {
      name: 'request_cancel',
      activity: 'filed a cancellation request',
      description:
        'Propose cancelling an order before it arrives. Always allowed — this only creates ' +
        'a pending request and tells you whether the order can still be stopped. It cancels ' +
        'nothing on its own.',
      inputSchema: obj({ orderId: str('Order id.') }, ['orderId']),
      async execute(i, ctx) {
        const order = await data.getOrder(String(i.orderId ?? ''));
        if (!order) return { ok: false, message: 'Unknown order.' };
        const eligibility = evaluateOrderChange(order, 'cancel');
        const requestId = newRequestId();
        const req: PendingRequest = {
          requestId, kind: 'cancel', orderId: order.orderId, itemId: '', reason: null,
          requestedBy: ctx.origin, eligibility,
        };
        pending.set(requestId, req);
        // Same rule as request_return: raise the affordance only for a request that could
        // actually complete, so a denial never renders as something to click past.
        if (eligibility.eligible) onConfirmationNeeded?.(req, 'cancel_order');
        return { ok: true, requestId, eligibility };
      },
    },
    {
      name: 'request_address_change',
      activity: 'filed an address change',
      description:
        'Propose redirecting an order to a different address before it arrives. Always ' +
        'allowed — this only creates a pending request and tells you whether the order can ' +
        'still be redirected. It changes nothing on its own.',
      inputSchema: obj({
        orderId: str('Order id.'),
        address: str('The full new delivery address, as the customer gave it.'),
      }, ['orderId', 'address']),
      async execute(i, ctx) {
        const order = await data.getOrder(String(i.orderId ?? ''));
        if (!order) return { ok: false, message: 'Unknown order.' };
        // An address change with no address is not a request, it's a blank cheque — the
        // person would be asked to confirm a redirect to nowhere. change_address had no
        // address field at all before this, which is the same defect one step earlier.
        const checkedAddress = validateAddress(i.address);
        if (!checkedAddress.ok) return { ok: false, message: checkedAddress.message };
        const address = checkedAddress.address;
        const eligibility = evaluateOrderChange(order, 'address-change');
        const requestId = newRequestId();
        const req: PendingRequest = {
          requestId, kind: 'address-change', orderId: order.orderId,
          itemId: '', reason: null, address, requestedBy: ctx.origin, eligibility,
        };
        pending.set(requestId, req);
        if (eligibility.eligible) onConfirmationNeeded?.(req, 'change_address');
        return { ok: true, requestId, eligibility, address };
      },
    },
    {
      name: 'request_records_release',
      activity: 'asked to release your account records',
      description:
        "Propose releasing the customer's own account records for one order — the card " +
        'type and its last four digits, the billing postcode, and the delivery address ' +
        'on file. Always allowed: this only creates a pending request and discloses ' +
        'nothing. The records are not readable any other way, including by you.',
      inputSchema: obj({ orderId: str('Order id.') }, ['orderId']),
      async execute(i, ctx) {
        const order = await data.getOrder(String(i.orderId ?? ''));
        if (!order) return { ok: false, message: 'Unknown order.' };
        const eligibility = evaluateRecordsRelease(order);
        const requestId = newRequestId();
        const req: PendingRequest = {
          requestId, kind: 'records-release', orderId: order.orderId,
          itemId: '', reason: null, requestedBy: ctx.origin, eligibility,
        };
        pending.set(requestId, req);
        onConfirmationNeeded?.(req, 'disclose_order_records');
        return { ok: true, requestId, eligibility };
      },
    },
    gated('disclose_order_records', 'records-release',
      "Release the customer's account records for a pending request: card type and last " +
      'four digits, billing postcode, and delivery address. The values are held by the ' +
      'server and returned only against a completed confirmation — this page never has ' +
      'them beforehand, so there is nothing here to read without the customer present.',
      'Account records released.'),
    {
      name: 'await_reply',
      activity: 'is waiting for a reply',
      description:
        'Wait here until someone else says something. Nothing is pushed to you otherwise: ' +
        'this page can only answer calls you make, so after you say something, the reply ' +
        'exists in the conversation but you will not see it until your next call. Call ' +
        'this to wait for it instead of ending your turn or polling in a loop. It returns ' +
        'as soon as there is anything new, or after a few seconds with nothing_new: true ' +
        'if the conversation stayed quiet — call it again if you are still waiting. Safe ' +
        'to call at any time; it changes nothing and can wait on nothing but conversation.',
      annotations: ro,
      inputSchema: obj({
        timeout_ms: {
          type: 'number',
          description: 'How long to wait before giving up, in milliseconds. Default 25000, max 30000.',
        },
      }),
      async execute(i, ctx) {
        // Clamped, not trusted: an unbounded wait is a tool call that never returns, and
        // most agent runtimes will simply time it out and report an error the model then
        // has to interpret. Better to return honestly before anyone else gives up on us.
        const asked = typeof i.timeout_ms === 'number' && Number.isFinite(i.timeout_ms)
          ? i.timeout_ms : DEFAULT_WAIT_MS;
        const timeout = Math.min(Math.max(asked, MIN_WAIT_MS), MAX_WAIT_MS);

        // Already behind? Return at once. Waiting for the NEXT entry when an unseen one is
        // already sitting there would stall for the full timeout and then deliver stale
        // news — the failure this tool exists to prevent, reintroduced by the tool itself.
        if (bus.since(ctx.cursor).entries.length > 0) {
          return { waited_ms: 0, nothing_new: false };
        }

        const started = now();
        const settled = await new Promise<boolean>(resolve => {
          let done = false;
          const finish = (v: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            unsubscribe();
            resolve(v);
          };
          // Subscribed BEFORE the timer is read, and unsubscribed on either path — a
          // subscriber left behind here would accumulate one per waiting call for the life
          // of the page, each holding a resolve nobody is listening for.
          const unsubscribe = bus.subscribe(() => finish(true));
          const timer = setTimeout(() => finish(false), timeout);
        });
        // The entries themselves ride back on room_since_last_call like every other tool's
        // do (see withPiggyback) — there is no second delivery path to keep in step.
        return { waited_ms: now() - started, nothing_new: !settled };
      },
    },
    gated('confirm_return', 'return',
      'Confirm and complete a pending return or warranty claim, refunding the customer.',
      'Return confirmed and refund issued.'),
    gated('cancel_order', 'cancel', 'Cancel the order.', 'Order cancelled.'),
    gated('change_address', 'address-change', 'Change the delivery address.',
      'Delivery address updated.'),
  ];
  return withGatewayDestroy(tools, destroy);
}

export type Consumer = 'visiting-agent' | 'site-agent';

/**
 * The store's agent speaks natively and has nothing to front-load, so it gets neither of
 * the first two. It is also excluded from await_reply, and that one is not a matter of
 * taste: it is already inside a live session that pushes every new entry to it, so it has
 * nothing to wait for — and a tool call that deliberately does not return for 25 seconds
 * would stall its own turn, holding the response guard open while the person watches it
 * say nothing.
 */
const SITE_AGENT_EXCLUDED = ['send_message', 'provide_context', 'await_reply'];

/**
 * "One registry" means one implementation per tool, not one flat list handed to everyone.
 * Consumers get different views of the same functions.
 *
 * Fails CLOSED: only the recognized 'visiting-agent' value gets the full set. Anything
 * else — including a value this union doesn't yet name — gets the restricted set, so a
 * bug or a future consumer type can never silently fall through to full access.
 */
export function scopeFor(tools: Tool[], consumer: Consumer): Tool[] {
  return consumer === 'visiting-agent'
    ? tools
    : tools.filter(t => !SITE_AGENT_EXCLUDED.includes(t.name));
}

/**
 * Wrap a tool set for ONE consumer. Every result carries the log entries that consumer
 * has not yet seen, so an agent stays current without polling. Call once per consumer —
 * the cursor is per-consumer state.
 */
export function withPiggyback(
  tools: Tool[], bus: Bus, onActivity?: (activity: string, tool: string) => void,
): Tool[] {
  let cursor: string | null = null;
  return tools.map(tool => ({
    ...tool,
    async execute(input: Record<string, unknown>, ctx: CallContext) {
      // Announced BEFORE the call, not after: a tool that takes a second to answer should
      // show its work while it is working, which is the whole point of narrating it.
      if (tool.activity) onActivity?.(tool.activity, tool.name);
      // The cursor belongs to THIS consumer and lives here, so a tool that needs to know
      // what this caller has already seen — await_reply is the only one — gets it from
      // the wrapper rather than keeping a second copy that could drift.
      const result = await tool.execute(input, { ...ctx, cursor });
      const { entries, cursor: next } = bus.since(cursor);
      cursor = next;
      const base = result && typeof result === 'object' ? result : { value: result };
      return { ...base, room_since_last_call: entries.map(publicEntry) };
    },
  }));
}
