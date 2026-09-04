import type { Bus } from './bus';
import { renderEntry } from './prompt';
import { verifyHumanPresence, type VerifyFailure, type VerifyResult } from './verify';
import type { ConfirmationProof, LogEntry, PolicyRules, ReturnReason, Tool } from './types';

export type SessionState = 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface SessionOpts {
  apiBase: string;
  now: () => number;
  tokenUrl: string;
  tools: Tool[];
  systemPrompt: string;
  bus: Bus;
  /**
   * Read for `requireHardwareConfirmation` only — see confirmRequest. Passed as the
   * whole rules object, the same slice checkGate already receives, rather than a single
   * boolean field that would need to be kept in sync with it separately.
   */
  policyRules: PolicyRules;
  /**
   * Threaded straight through to verifyHumanPresence — see its own doc comment. Omitted
   * for the flagship, matching WidgetConfig's `tenant`.
   */
  tenant?: string;
  onState?(s: SessionState): void;
}

export interface Session {
  start(): Promise<void>;
  sendUserText(text: string): void;
  /**
   * Runs the verification ceremony and, only on success, appends the confirmation.
   * There is deliberately NO parameter for handing in a Verification — that was the
   * hole in the previous design. An agent may call this; it will raise a prompt it
   * cannot satisfy.
   * `details` is the eligibility triple this ceremony binds to — the Worker requires it
   * at /options time for confirm_return and there is no second chance to supply it later.
   * EXCEPT when `policyRules.requireHardwareConfirmation` is the demo's explicit `false`:
   * then no ceremony runs at all, a bare click authorises on purpose, and this resolves
   * to the explicit `{ method: 'none' }` variant of VerifyResult rather than a
   * ConfirmationProof — never `undefined`. An absent return value must never be the
   * thing that means "confirmed"; a value that says so explicitly can't go missing by
   * accident.
   * When the real ceremony runs but this device genuinely has no authenticator, the
   * result depends on `policyRules.onMissingAuthenticator`: 'refuse' (the default)
   * resolves to `{ error: 'no-authenticator' }`; 'trusted-click' resolves to a
   * TrustedClickRecord instead — a weaker, Worker-recorded-but-not-cryptographically-
   * verified level, distinct from both a Verification and the demo bypass above.
   */
  confirmRequest(
    requestId: string, tool: string,
    details: { orderId: string; itemId: string; reason: ReturnReason | null; scope?: string; address?: string },
  ): Promise<VerifyResult>;
  close(): void;
}

export function toRealtimeTools(tools: Tool[]) {
  return tools.map(t => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

export function logToItems(entries: readonly LogEntry[]) {
  return entries.map(e => {
    const { role, text } = renderEntry(e);
    return role === 'assistant'
      ? { type: 'message', role, content: [{ type: 'text', text }] }
      : { type: 'message', role, content: [{ type: 'input_text', text }] };
  });
}

/**
 * The Realtime API errors if response.create arrives while a response is generating.
 * A turn that contains a function call closes with its OWN response.done for that turn,
 * so a naive "clear on response.done, re-request on function_call_arguments.done" design
 * lets a stray event from turn A clear or re-trigger state that by then belongs to turn
 * B. This state machine is pulled out of the WebRTC closure specifically so that
 * interleaving can be exercised without a live connection — see session.test.ts.
 */

/**
 * A response.created event without an id (not supposed to happen, but the wire format is
 * not something this file controls) still needs its eventual settle recognized as
 * belonging to it. This is deliberately NOT represented as `null` — null means "nothing is
 * active", and treating it as a wildcard for "match whatever settles next" would reopen
 * the exact continuation-window bug the id keying exists to close, just from idle state
 * instead of from turn A. A distinct sentinel keeps the two meanings apart.
 */
export const UNKNOWN_RESPONSE_ID = Symbol('unknown-response-id');

export interface ResponseGuardState {
  responseActive: boolean;
  /** The response.id currently generating, so a settled event for a stale response can
   *  be told apart from one for the response actually live now. */
  activeResponseId: string | typeof UNKNOWN_RESPONSE_ID | null;
  responseQueued: boolean;
  /** A function call finished during the active response and its continuation has not
   *  been requested yet — either because the turn hasn't settled, or because settling
   *  raced ahead of the tool call and this flag is how the tool call catches up. */
  needsContinuation: boolean;
}

export function initialResponseGuardState(): ResponseGuardState {
  return { responseActive: false, activeResponseId: null, responseQueued: false, needsContinuation: false };
}

/** A response.create was requested (by the human, their agent, or a queued drain). Returns
 *  whether to actually send it now; if one is already active, queues it instead. */
export function guardRequestResponse(s: ResponseGuardState): boolean {
  if (s.responseActive) { s.responseQueued = true; return false; }
  s.responseActive = true;
  return true;
}

/** The caller asked guardRequestResponse to send now, then the actual write failed (e.g.
 *  the data channel was not open yet mid-handshake). Reverts to queued so a later drain —
 *  once the channel opens — picks it up, instead of leaving the guard stuck "active" with
 *  nothing ever sent and no response.done ever coming to clear it. */
export function guardSendFailed(s: ResponseGuardState): void {
  s.responseActive = false;
  s.responseQueued = true;
}

export function guardResponseCreated(s: ResponseGuardState, responseId: string | null): void {
  s.activeResponseId = responseId ?? UNKNOWN_RESPONSE_ID;
  s.responseActive = true;
}

/**
 * Called once a function_call_output has actually been sent — never before, since the
 * model cannot use an output it has not received yet. The turn's response.done may have
 * already arrived while the tool call was in flight (responseActive false here — settle
 * this call's continuation immediately) or may still be coming (responseActive true —
 * leave a flag for guardResponseSettled to act on). Either path fires the continuation
 * exactly once, including when several function calls land in the same turn.
 */
export function guardFunctionOutputSent(s: ResponseGuardState): boolean {
  if (s.responseActive) { s.needsContinuation = true; return false; }
  return guardRequestResponse(s);
}

/**
 * response.done or error. `responseId` is the settling response's id for response.done,
 * or null for error (not scoped to one response — and a malformed done with no id — so
 * it always clears rather than risk a permanent hang). A non-null id that does not match
 * the response actually live now is a stale event and must be ignored, not allowed to
 * clear or re-trigger state for the live one.
 */
export function guardResponseSettled(s: ResponseGuardState, responseId: string | null): boolean {
  // Reject only a KNOWN mismatch: a real incoming id that disagrees with a real tracked
  // id. If the tracked id is the unknown-sentinel, the next settle is trusted to be it,
  // by design. If nothing is tracked (activeResponseId null — idle), a real incoming id
  // still disagrees with null and is correctly rejected below; null is never read as "match
  // anything" here, only as one of the two operands being compared.
  const knownMismatch = responseId !== null
    && s.activeResponseId !== UNKNOWN_RESPONSE_ID
    && responseId !== s.activeResponseId;
  if (knownMismatch) return false;
  s.responseActive = false;
  s.activeResponseId = null;
  if (s.needsContinuation) { s.needsContinuation = false; return guardRequestResponse(s); }
  if (s.responseQueued) { s.responseQueued = false; return guardRequestResponse(s); }
  return false;
}

export function createSession(opts: SessionOpts): Session {
  const byName = new Map(opts.tools.map(t => [t.name, t]));
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let unsubscribe: (() => void) | null = null;
  const ceremonies = new Set<string>();
  let closed = false;

  let guard = initialResponseGuardState();
  // Bumped on every connect(). A tool call captures this before awaiting tool.execute; if
  // it has moved on by the time the tool resolves, the connection that call belongs to is
  // gone and its output (a dead call_id) must be dropped rather than sent on the new one.
  let generation = 0;

  /** Returns whether the message actually went out, so a caller that changed guard state
   *  in anticipation of a successful send can notice a failure and undo it. */
  const send = (msg: unknown): boolean => {
    if (dc?.readyState !== 'open') return false;
    dc.send(JSON.stringify(msg));
    return true;
  };

  const requestResponse = () => {
    if (!guardRequestResponse(guard)) return;
    // Mid-handshake the channel may not be open yet. Don't strand the guard "active" with
    // nothing sent and no response.done ever coming to clear it — revert to queued so the
    // drain in the data channel's 'open' handler below picks it up once it can.
    if (!send({ type: 'response.create' })) guardSendFailed(guard);
  };

  // GA shape for a text-mode Realtime session: `session.type` is required, and beta's
  // `modalities` is now `output_modalities` taking exactly one value. The response
  // handler above consumes the completed text event.
  const configure = () => send({
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: opts.systemPrompt,
      tools: toRealtimeTools(opts.tools),
      tool_choice: 'auto',
      // Text only. This widget has no audio surface: the store agent's replies are read,
      // never heard, and the customer types rather than speaks.
      output_modalities: ['text'],
    },
  });

  // GA and beta spellings both, see the handler below.
  const TURN_DONE_EVENTS = new Set([
    'response.output_text.done',
    'response.output_audio_transcript.done',
    'response.audio_transcript.done',
  ]);
  // Event families this session deliberately ignores (streaming deltas, lifecycle noise).
  // Anything outside these is logged so an upstream rename surfaces instead of going quiet.
  const HANDLED_EVENT_PREFIXES = [
    'response.', 'session.', 'conversation.', 'input_audio_buffer.', 'rate_limits.',
    'output_audio_buffer.', 'transcription_session.',
  ];

  async function onEvent(ev: MessageEvent) {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'response.created') {
      guardResponseCreated(guard, msg.response?.id ?? null);
      return;
    }

    if (msg.type === 'response.function_call_arguments.done') {
      const myGeneration = generation;
      const tool = byName.get(msg.name);
      const input = (() => { try { return JSON.parse(msg.arguments || '{}'); } catch { return {}; } })();
      let output: unknown;
      try {
        output = tool
          ? await tool.execute(input, { origin: 'site-agent', cursor: null })
          : { error: `unknown tool ${msg.name}` };
      } catch (err) {
        // Never let a tool throw across the session boundary.
        output = { error: String(err) };
      }
      // A reconnect may have happened while the tool was running. Its output would carry
      // a dead connection's call_id, and firing a continuation would collide with the
      // fresh connection's own guard state — drop it instead of sending either.
      if (myGeneration !== generation) return;
      // Tool.execute's return type permits undefined. JSON.stringify(undefined) is the
      // value undefined, and the outer stringify then drops the key entirely — the call
      // would go out with no `output` field at all, unanswered. Never emit that.
      if (output === undefined) output = { ok: false, error: 'tool returned no result' };
      send({ type: 'conversation.item.create', item: {
        type: 'function_call_output', call_id: msg.call_id, output: JSON.stringify(output) } });
      if (guardFunctionOutputSent(guard)) send({ type: 'response.create' });
      return;
    }


    if (msg.type === 'response.done' || msg.type === 'error') {
      const responseId = msg.type === 'error' ? null : (msg.response?.id ?? null);
      if (guardResponseSettled(guard, responseId)) send({ type: 'response.create' });
      // fall through: a response.done may also carry the final text below
    }

    // The text-mode Realtime session finished a turn. Both retained completion-event
    // spellings are accepted because GA renamed beta's event family. A silent mismatch
    // here is invisible: the connection is fine, the model replies, and the reply never
    // reaches the transcript.
    if (TURN_DONE_EVENTS.has(msg.type)) {
      const text = (msg.text ?? msg.transcript ?? '').trim();
      if (text) opts.bus.append({ origin: 'site-agent', text });
      return;
    }

    // Anything this handler doesn't recognize gets named rather than dropped. The beta-to-
    // GA rename shipped a dead integration that every test passed over; an unrecognized
    // event type is the one signal that would have caught it from inside a live session.
    if (!HANDLED_EVENT_PREFIXES.some(p => msg.type?.startsWith(p))) {
      console.debug('[3way] unhandled realtime event', msg.type);
    }
  }

  async function connect() {
    if (closed) return;   // start() may race a same-tick close(); nothing to build yet.
    opts.onState?.(pc ? 'reconnecting' : 'connecting');
    // A drop mid-response means no response.done will ever arrive to clear these. Without
    // this reset the session deadlocks: every later append queues and nothing is ever sent.
    guard = initialResponseGuardState();
    generation++;

    // close() only closes whatever pc/dc exist AT THE INSTANT it runs. If it runs while
    // this call is parked at one of the awaits below, there is nothing yet for it to
    // close — so every await point below re-checks `closed` itself and tears down
    // anything THIS call has already built, rather than run to completion and leak a
    // fresh peer connection that close() never saw.
    const teardown = () => { dc?.close(); pc?.close(); dc = null; pc = null; };

    const tokenRes = await fetch(opts.tokenUrl, { method: 'POST' });
    if (closed) { teardown(); return; }
    if (!tokenRes.ok) throw new Error('token_mint_failed');
    const token = (await tokenRes.json()) as { client_secret: { value: string }; model: string };
    if (closed) { teardown(); return; }

    pc = new RTCPeerConnection();
    // This text-mode Realtime session needs a required audio media line in its SDP offer.
    // The receive-only transceiver is never fed and no remote track is played. This
    // handshake is a single offer/answer with no renegotiation path to add one later, so
    // removing it changes the wire and requires a verified replacement.
    pc.addTransceiver('audio', { direction: 'recvonly' });
    if (closed) { teardown(); return; }

    dc = pc.createDataChannel('oai-events');
    dc.addEventListener('message', onEvent);
    dc.addEventListener('open', () => {
      configure();
      // The log is the source of truth; the session is a view of it. Rebuild on every connect.
      for (const item of logToItems(opts.bus.all())) send({ type: 'conversation.item.create', item });
      // requestResponse's failed-send fallback may have left a response queued while the
      // channel was still connecting. Nothing else would ever drain it — no response.done
      // is coming for a response.create that was never actually sent.
      if (guard.responseQueued) { guard.responseQueued = false; requestResponse(); }
      opts.onState?.('live');
    });

    pc.onconnectionstatechange = () => {
      if (closed) return;
      if (pc?.connectionState === 'failed' || pc?.connectionState === 'disconnected') {
        opts.onState?.('reconnecting');
        void connect().catch(() => opts.onState?.('closed'));
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (closed) { teardown(); return; }
    const sdp = await fetch(`https://api.openai.com/v1/realtime/calls?model=${token.model}`, {
      method: 'POST',
      body: offer.sdp,
      headers: { authorization: `Bearer ${token.client_secret.value}`, 'content-type': 'application/sdp' },
    });
    if (closed) { teardown(); return; }
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdp.text() });
    if (closed) teardown();
  }

  return {
    async start() {
      if (closed) return;   // makes a start() after close() a no-op, not just "usually fine"
      await connect();
      // connect() may have bailed out partway through because close() ran while it was
      // parked at one of its awaits — in which case there is no live channel to speak
      // through, and subscribing here would be the one leak teardown() cannot reach from
      // inside connect() itself (this closure, not connect()'s, owns `unsubscribe`).
      if (closed) return;
      // Everything the human or their agent says reaches the session through exactly
      // one path: the bus. This is why there is never a second copy to keep in step.
      unsubscribe = opts.bus.subscribe(entry => {
        if (entry.origin === 'site-agent') {
          // The model wrote this one; it is already in context and re-sending would echo.
          if (!entry.authoredByTool) return;
          // A TOOL wrote this one. The model has never seen it, and without it the model
          // contradicts its own completed action — observed live, asking for a
          // confirmation directly below its own "refund issued" line. Context only: the
          // tool's line IS the turn, so no new response is requested.
          const [toolItem] = logToItems([entry]);
          send({ type: 'conversation.item.create', item: toolItem });
          return;
        }
        const [item] = logToItems([entry]);
        send({ type: 'conversation.item.create', item });
        // A confirmation is answered by the action it authorises, not by a fresh turn.
        // Asking for one races the tool and produces "please confirm in the widget"
        // moments after the widget confirmed it.
        if (entry.confirms) return;
        requestResponse();
      });
    },
    sendUserText(text) { opts.bus.append({ origin: 'human-direct', text }); },
    async confirmRequest(requestId, tool, details) {
      // One ceremony at a time per (requestId, tool). Blunts accidental prompt spam
      // without punishing a legitimate retry: the modal invites an immediate second
      // attempt after a cancel, and a post-completion cooldown would swallow that click
      // and report it as the HUMAN cancelling. Guard on in-flight only.
      // This only prevents duplicate local clicks; server-side token binding remains authoritative.
      const key = `${requestId}:${tool}`;
      if (ceremonies.has(key)) return { error: 'cancelled' };
      ceremonies.add(key);
      try {
        // Fail closed: only an explicit `false` selects the deliberately vulnerable
        // path below — the same rule checkGate already applies to this exact flag.
        // Missing, undefined, or garbage still runs the real ceremony.
        if (opts.policyRules.requireHardwareConfirmation === false) {
          // THE VULNERABLE DESIGN, reproduced on purpose: a bare click authorises. No
          // WebAuthn ceremony runs, and the entry carries no `verification` — this is
          // exactly what checkGate's weak branch (bus.hasHumanConfirmation) accepts on
          // origin alone. The flag exists so the demo can show this working, then show
          // the identical click refused once the flag is back on; it does not exist to
          // be forgotten on.
          // The BUS ENTRY carries no `verification` — that's what checkGate's weak
          // branch actually keys on, and it's real, not faked. The RETURN VALUE below is
          // a separate concern: a distinct, explicit VerifyResult variant, not
          // `undefined` — an absent value must never be the thing a caller reads as
          // "confirmed," or a future early return with no value silently grants one.
          opts.bus.append({
            origin: 'human-direct', text: 'Yes, I confirm.', confirms: requestId, confirmsTool: tool,
          });
          return { method: 'none', at: opts.now() };
        }

        let result: ConfirmationProof | { error: VerifyFailure };
        try {
          result = await verifyHumanPresence({
            apiBase: opts.apiBase, requestId, tool, now: opts.now, tenant: opts.tenant,
            // `null` is how a cancellation or address change says "the returns policy has
            // no verdict here" — send the field absent rather than as a null the Worker
            // would have to reject. It requires the triple only for confirm_return, which
            // is the one kind that always carries a real reason.
            orderId: details.orderId, itemId: details.itemId, reason: details.reason ?? undefined,
            scope: details.scope, address: details.address,
            // See PolicyRules.onMissingAuthenticator's own doc — consulted by
            // verifyHumanPresence only once it has independently confirmed the
            // authenticator is genuinely absent, never before.
            onMissingAuthenticator: opts.policyRules.onMissingAuthenticator,
          });
        } catch {
          return { error: 'rejected' };   // never reject out of confirmRequest
        }
        if ('error' in result) return result;
        opts.bus.append({
          origin: 'human-direct', text: 'Yes, I confirm.', confirms: requestId, confirmsTool: tool, verification: result,
        });
        return result;
      } finally {
        ceremonies.delete(key);
      }
    },
    close() {
      closed = true;
      unsubscribe?.();
      dc?.close();
      pc?.close();
      opts.onState?.('closed');
    },
  };
}
