import { CSS } from './styles';
import type { Bus } from '../bus';
import type { VerifyFailure } from '../verify';
import type { LogEntry, PendingRequest, ReturnReason } from '../types';

const FAILURE_MESSAGE: Record<VerifyFailure, string> = {
  'no-authenticator':
    'This device has no fingerprint or face unlock set up, so we cannot confirm this action ' +
    'here. Open this page on a device that does, or contact us directly.',
  'unsupported': 'This browser cannot verify it is you. Try Chrome, Edge or Safari.',
  'cancelled': 'Verification was cancelled. Nothing has changed — try again when ready.',
  'rejected': 'We could not verify that. Please try once more.',
  // Deliberately does NOT say "try again": the confirmation was recorded and the token
  // is spent, so a second press cannot help. Assurance-neutral wording prevents a
  // trusted-click completion from being mislabeled as device verification, while the
  // explicit refusal prevents the person from believing the action succeeded.
  'action-failed':
    'Your confirmation was recorded, but the action did not go through — the server refused it. ' +
    'Nothing has changed. Ask the assistant to check the action status, or contact us directly.',
  // A lost response is not a refusal: the Worker may have completed and burned the token.
  // Retrying from this box would resend that same token and can duplicate work inside the
  // KV stale-read window documented by /api/act, so this outcome is terminal and says so.
  'action-indeterminate':
    'Your confirmation was recorded, but we could not confirm whether this completed. Do not retry; ' +
    'check the order or release status first, then contact us if it is still unclear.',
};

/**
 * Shown proactively (mount-time probe already knows this device has no authenticator)
 * when PolicyRules.onMissingAuthenticator is 'trusted-click' — the button STAYS live,
 * unlike the FAILURE_MESSAGE['no-authenticator'] case, which removes it. Says plainly
 * what's actually happening: this is a weaker, honestly-labelled level, not the real
 * hardware check. See TrustedClickRecord's doc comment (types.ts) for why.
 */
const TRUSTED_CLICK_NOTICE =
  'This device has no fingerprint or face unlock set up. Confirming here will be ' +
  'recorded as a trusted click, not verified by hardware — a weaker guarantee than a ' +
  'device with one. If you have a device with a fingerprint or face sensor, use that instead.';

/**
 * Shown when the confirm button fires on an event with isTrusted === false — a
 * synthetic click, the exact shape a computer-use agent produces by driving the DOM
 * directly (measured working against one real agent; see README.md's measurement
 * table). Checked before anything else in the click handler, regardless of which
 * assurance level would otherwise apply: an untrusted click never even starts a
 * ceremony, real or trusted-click.
 */
const UNTRUSTED_CLICK_MESSAGE =
  "That click didn't register as coming from you directly, so nothing was confirmed. " +
  'Please tap the button yourself.';

// A resolution's `reason` comes from onConfirm, which reaches the
// network — a malformed or unrecognized reason must fall back to a known message
// rather than render "undefined" (or any other stray string) to the person.
const isKnownFailure = (v: unknown): v is VerifyFailure =>
  typeof v === 'string' && Object.hasOwn(FAILURE_MESSAGE, v);

// 'site-agent' is deliberately absent here — it's supplied per mount via ModalOpts.
// storeAgentLabel (built in createModal below), not hardcoded. This is a shared bundle:
// one tenant's store name baked in here would label every OTHER tenant's agent with it
// too (this is literally how one store name ended up on another site's transcript).
const LABEL: Omit<Record<LogEntry['origin'], string>, 'site-agent'> = {
  'human-direct': 'You',
  'agent-relay': "Your agent (relaying)",
  'agent-autonomous': 'Your agent',
};

/**
 * What the confirm box tells the person they're about to authorize. The confirmation
 * flow binds a token to the action shown, so it cannot be pointed at "a different action than
 * the one shown" — but until this existed, the box showed the order and the eligibility
 * verdict and never the action itself. All three gated tools share one `pending` map
 * keyed only by requestId (tools.ts), so an agent could raise a return-framed box and
 * then call change_address with that same requestId: the token binding stops the ACTION,
 * but the person would have been shown the wrong thing. Falls back to the raw tool name
 * for any future gated tool this map hasn't been updated for, rather than rendering
 * nothing.
 */
/**
 * What is being authorized, in the person's own terms — always rendered, never behind a
 * disclosure. Kept deliberately literal: identifiers and the values the person supplied,
 * never a model's paraphrase of them, because this is the line the consent is actually
 * given against. `eligibility.path` rides along because "warranty" versus "change of
 * mind" changes what the person is agreeing to, not merely why it was allowed.
 */
export function subjectLine(req: PendingRequest): string {
  const parts: string[] = [req.orderId];
  // One order can contain several returnable lines. Omitting these made two requests for
  // different items render as the same consent even though the Worker binds the exact
  // (orderId, itemId, reason) triple and will execute only one of them.
  if (req.kind === 'return') {
    parts.push(`item ${req.itemId || '(missing)'}`);
    parts.push(`reason: ${req.reason ?? '(missing)'}`);
  }
  // The address is the whole point of an address change; a redirect the person cannot
  // read is a blank cheque (same defect request_address_change fixed one step earlier).
  if (req.kind === 'address-change' && req.address) parts.push(`new address: ${req.address}`);
  // The clinic binds the recipient into itemId — who the records go to is the decision.
  if (req.kind === 'disclosure' && req.itemId) parts.push(`to ${req.itemId}`);
  if (req.scope === 'include-restricted') parts.push('INCLUDES RESTRICTED RECORDS');
  parts.push(req.eligibility.path);
  return parts.join(' · ');
}

export const ACTION_LABEL: Record<string, string> = {
  confirm_return: 'Confirm this return and issue the refund',
  cancel_order: 'Cancel this order',
  change_address: 'Change the delivery address on this order',
  disclose_order_records: 'Release your account records for this order',
  release_records: 'Send these records to the recipient named below',
};

export interface ModalOpts {
  bus: Bus;
  onSend(text: string): void;
  /**
   * Resolves ok only when the SERVER accepted a real assertion. `details` is the
   * eligibility triple this specific confirmation binds to — the Worker needs it at
   * /options time, before the ceremony runs (see session.ts's confirmRequest).
   */
  onConfirm(
    requestId: string, tool: string,
    details: { orderId: string; itemId: string; reason: ReturnReason | null; scope?: string;
      address?: string },
  ): Promise<{ ok: true; data?: Record<string, unknown> } |
    { ok: false; reason: VerifyFailure }>;
  /** Set once the mount-time probe resolves; renders the unavailable state up front. */
  authenticatorAvailable?: () => boolean | undefined;
  /**
   * PolicyRules.onMissingAuthenticator, threaded straight through — decides what the
   * confirm box shows and whether the button stays live when the mount-time probe
   * already knows this device has no authenticator. Optional and defaults to 'refuse'
   * when omitted, matching every other fail-closed flag in this codebase — never
   * "missing means weaker."
   */
  onMissingAuthenticator?: 'refuse' | 'trusted-click';
  /**
   * Display label for the store's own agent in the transcript (e.g. "Halden Support").
   * Defaults to "Store" when omitted — see the note above LABEL for why this cannot be a
   * constant baked into the shared bundle.
   */
  storeAgentLabel?: string;
  /**
   * Keyholder mode (the default, false): no text composer — the person's only affordance
   * is authorizing a consequential step. Composer mode (true) restores the composer for
   * flows that need information only the person can supply (the clinic). See createModal.
   */
  composer?: boolean;
}

export interface Modal {
  el: HTMLElement;
  requestConfirmation(req: PendingRequest, tool: string): void;
  /** Narrates a visiting agent's tool call. Not a transcript entry — see Tool.activity. */
  showActivity(activity: string): void;
  destroy(): void;
}

// The layer's own mark, inlined (not fetched): the widget is a drop-in on someone else's
// page, so it cannot rely on a favicon.svg being reachable at any known path. White ground
// so it reads on any header. Same three shapes as the site favicon — person (circle) in
// present-green, the two agents (diamond, pentagon) in agent-violet, in an ink frame.
const BRAND_MARK =
  '<svg class="head__mark" viewBox="0 0 1080 1080" aria-hidden="true">' +
  '<path fill="none" stroke="#11151A" stroke-width="70" stroke-linecap="round" stroke-linejoin="round" d="m953 250v502h-826v-502z"/>' +
  '<path fill="#0B6E5F" stroke="#0B6E5F" stroke-width="70" stroke-linejoin="round" stroke-linecap="round" d="m539.5 865c-64.98 0-117.5-52.52-117.5-117.5 0-64.98 52.52-117.5 117.5-117.5 64.98 0 117.5 52.52 117.5 117.5 0 64.98-52.52 117.5-117.5 117.5z"/>' +
  '<path fill="#5B3FD1" stroke="#5B3FD1" stroke-width="70" stroke-linejoin="round" stroke-linecap="round" d="m819.09 422.08l-35.87 109.92-115.63-0.14-35.59-110.01 93.63-67.85z"/>' +
  '<path fill="#5B3FD1" stroke="#5B3FD1" stroke-width="70" stroke-linejoin="round" stroke-linecap="round" d="m440.65 450.8l-89.65 89.65-89.65-89.65 89.65-89.65z"/>' +
  '</svg>';

export function createModal(opts: ModalOpts): Modal {
  const storeAgentLabel = opts.storeAgentLabel ?? 'Store';
  // Keyholder mode (the default) renders no text composer: the person's only action is
  // authorizing a consequential step — the one thing no agent can forge — while the
  // conversation runs agent-to-agent in the open ledger. Removing the composer removes the
  // one human-typing surface an agent could impersonate; the gate, not the box, is still
  // where authority lives. Composer mode (true) restores the box for flows that need
  // information only the person can supply (the clinic). See docs/WEBMCP.md.
  const composer = opts.composer ?? false;
  const emptyBody = composer
    ? `<b>Tell your agent to talk to me.</b>
        <span>Send it here and it can look things up, check the policy and file a
        claim — in this thread, where you can read every word. Or just type below.</span>`
    : `<b>Your agent and this store's agent talk here.</b>
        <span>Point your agent at this page — it looks things up, checks the policy and
        files claims over WebMCP, in this thread where you read every word. You step in
        only to approve anything consequential.</span>`;
  const composerHtml = composer
    ? `<form><input data-3way-composer placeholder="Type a message (you, not your agent)" autocomplete="off"
        title="This box is the person's own channel; what is typed here is attributed to them. An agent speaks with the send_message tool on document.modelContext instead." />
        <button type="submit">Send</button></form>`
    : '';
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="panel">
      <div class="head">
        <a class="head__brand" href="https://3way.dev/" target="_blank" rel="noopener" title="3way — the layer this conversation runs on">${BRAND_MARK}3<span>way</span></a>
        <span class="head__name" data-3way-store-name></span>
        <span class="who">
          <span data-who="human" data-present="true">You</span>
          <span data-who="agent" data-present="false">Your agent</span>
        </span>
        <button type="button" data-3way-min title="Minimize" aria-label="Minimize the conversation">&#8211;</button>
        <button type="button" data-3way-expand title="Expand" aria-label="Expand the conversation">&#10530;</button>
      </div>
      <div class="log" data-3way-log><div class="empty" data-3way-empty>${emptyBody}</div></div>
      <div data-3way-confirm-slot></div>
      ${composerHtml}
    </div>`;

  // textContent, not interpolated into innerHTML above: storeAgentLabel is tenant
  // configuration, and configuration should never be able to inject markup.
  (root.querySelector('[data-3way-store-name]') as HTMLElement).textContent = storeAgentLabel;
  const agentChip = root.querySelector('[data-who="agent"]') as HTMLElement;
  const panel = root.querySelector('.panel') as HTMLElement;

  // The transcript IS the product here, and 384x612 in a corner is a porthole to read it
  // through. One control, two states — no drag handles to get wrong on a touch screen.
  (root.querySelector('[data-3way-expand]') as HTMLButtonElement).addEventListener('click', ev => {
    const wide = panel.getAttribute('data-wide') === 'true';
    panel.setAttribute('data-wide', String(!wide));
    (ev.currentTarget as HTMLElement).innerHTML = wide ? '&#10530;' : '&#10529;';
    log.scrollTop = log.scrollHeight;
  });

  // Minimize collapses the panel to just its header bar — the mark, the store name, and the
  // live roster stay visible so a person can tuck the exchange into the corner without
  // losing track of who is in the room. Default load is the full shape; this is an explicit
  // opt-in. The expand (wide) control is hidden while minimized — you cannot widen a bar
  // with nothing in it.
  (root.querySelector('[data-3way-min]') as HTMLButtonElement).addEventListener('click', ev => {
    const min = panel.getAttribute('data-min') === 'true';
    panel.setAttribute('data-min', String(!min));
    const btn = ev.currentTarget as HTMLElement;
    btn.innerHTML = min ? '&#8211;' : '&#9633;';
    btn.title = min ? 'Minimize' : 'Restore';
    btn.setAttribute('aria-label', min ? 'Minimize the conversation' : 'Restore the conversation');
    if (min) log.scrollTop = log.scrollHeight;
  });

  const log = root.querySelector('[data-3way-log]') as HTMLElement;
  // Removed on the first real line rather than hidden by CSS: an empty state that lingers
  // in the DOM is one a screen reader still reads out under a live conversation.
  const clearEmptyState = () => root.querySelector('[data-3way-empty]')?.remove();
  const slot = root.querySelector('[data-3way-confirm-slot]') as HTMLElement;
  const form = root.querySelector('form') as HTMLFormElement | null;
  const input = root.querySelector('[data-3way-composer]') as HTMLInputElement | null;

  /** Keeps the newest thing in view. Called after anything is added, and when the confirm
   *  box appears — otherwise the box arrives and pushes the reason for it out of sight. */
  const pin = () => { log.scrollTop = log.scrollHeight; };

  const render = (e: LogEntry) => {
    const line = document.createElement('div');
    line.className = 'line';
    line.setAttribute('data-3way-origin', e.origin);
    // This is the human-direct ingress path, not cryptographic proof — an agent's own
    // claim about itself is never marked this way. Named `direct`, not `verified`: only
    // a completed WebAuthn ceremony (bus.ts's hasVerifiedConfirmation) earns that word.
    line.setAttribute('data-3way-direct', String(e.origin === 'human-direct'));
    // Which assurance level this confirmation carries, if any — 'webauthn' or
    // 'trusted-click' — so a viewer of the TRANSCRIPT (not just the confirm box, which
    // is long gone by the time this renders) can see which level was actually used.
    // Absent entirely for an ordinary line, and for the demo's
    // requireHardwareConfirmation:false bypass (that path appends no `verification` at
    // all — see session.ts's confirmRequest).
    if (e.verification) line.setAttribute('data-3way-assurance', e.verification.method);
    const label = document.createElement('div');
    label.className = 'label';
    label.setAttribute('data-3way-label', '');
    label.textContent = e.origin === 'site-agent' ? storeAgentLabel : LABEL[e.origin];
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = e.text;
    // The roster is live rather than decorative: the visiting agent's chip stays dim
    // until it has actually said something, so the header answers "is anyone here on my
    // behalf?" without the person having to read the transcript to find out.
    if (e.origin === 'agent-relay' || e.origin === 'agent-autonomous') {
      agentChip.setAttribute('data-present', 'true');
    }
    clearEmptyState();
    line.append(label, body);

    // A completed confirmation carries the only cryptographic claim this system makes, and
    // until now it lived in a data attribute only devtools could see. Offer it.
    if (e.verification && e.confirms) {
      const proof = document.createElement('button');
      proof.type = 'button';
      proof.className = 'proof';
      proof.setAttribute('data-3way-proof', '');
      proof.textContent = 'What was verified?';
      const detail = document.createElement('div');
      detail.className = 'proof__detail';
      detail.hidden = true;
      const method = e.verification.method;
      detail.textContent = method === 'webauthn'
        // Deliberately NOT "it cannot be replayed". The Worker burns the token in
        // Workers KV, which has no compare-and-swap and is only eventually consistent —
        // its own comment at /api/act documents the window where a concurrent or
        // stale-read retry re-runs THIS ceremony's action, and names the Durable Object
        // that would close it as not taken. A categorical claim here is the one thing
        // this project cannot afford: the code is scrupulously honest about the gap and
        // the UI was overwriting that with a promise. Say what is actually enforced —
        // the request/tool binding — and do not imply the bearer token itself is bound
        // to a device merely because its minting ceremony checked that credential.
        ? `A device signature from this device's registered credential, checked by the server. `
          + `The authorization token is bound as single-use to request ${e.confirms} and action `
          + `(${e.confirmsTool ?? 'unknown'}) — it cannot be pointed at a different action. `
          + `The server records it `
          + `as spent after first use, but a concurrent request or a cross-location stale `
          + `read can repeat that same action before the spent record is observed.`
        : `No device signature — this browser reported no authenticator, and the confirmation was `
          + `recorded at a lower assurance. An honest record that somebody clicked, not proof of who.`;
      proof.addEventListener('click', () => {
        detail.hidden = !detail.hidden;
        proof.textContent = detail.hidden ? 'What was verified?' : 'Hide';
        pin();
      });
      line.append(proof, detail);
    }

    log.append(line);
    pin();
  };

  for (const e of opts.bus.all()) render(e);
  const off = opts.bus.subscribe(render);

  form?.addEventListener('submit', ev => {
    ev.preventDefault();
    const text = input!.value.trim();
    if (!text) return;
    input!.value = '';
    opts.onSend(text);
  });

  // The slot is one shared node across every gated call. `currentKey` is whichever
  // request:tool it currently shows; `pendingKey` is set only while a ceremony's
  // WebAuthn round trip is actually in flight (between click and resolution). A second
  // gated call arriving mid-ceremony must not yank the running one off screen — the tool
  // it came from already returned its needs-confirmation result, and the agent can ask
  // again once the slot is free.
  let currentKey: string | null = null;
  let pendingKey: string | null = null;

  return {
    el: host,
    showActivity(activity) {
      clearEmptyState();
      const line = document.createElement('div');
      line.className = 'activity';
      line.setAttribute('data-3way-activity', '');
      line.textContent = `Your agent ${activity}`;
      log.append(line);
      pin();
    },
    requestConfirmation(req, tool) {
      const key = `${req.requestId}:${tool}`;
      if (pendingKey !== null) return;
      // Idempotent for the request already on screen. A gated call that holds the line
      // (tools.ts's hold) re-raises the box on every re-arm, and rebuilding it collapsed
      // the "why" the person had opened and wiped a failure note they were reading, every
      // 25 seconds. Only a DIFFERENT request replaces what is showing; a completed one has
      // already cleared currentKey, so a fresh request after it still renders.
      if (currentKey === key && slot.querySelector('.confirm:not(.confirm--result)')) return;
      currentKey = key;
      slot.replaceChildren();
      const box = document.createElement('div');
      box.className = 'confirm';
      // Three elements, not one paragraph. What is being authorised, what it applies to,
      // and why it qualifies are three different questions, and running them together as
      // prose made the one line a person must actually read before touching a sensor the
      // hardest thing in the box to find.
      const tag = document.createElement('span');
      tag.className = 'confirm__tag';
      tag.textContent = 'Needs your confirmation';
      const p = document.createElement('p');
      p.className = 'confirm__action';
      p.textContent = ACTION_LABEL[tool] ?? `Confirm this action (${tool})`;
      // The justification collapses; the ACTION never does. A confirm box tall enough to
      // crush the transcript behind it makes a person scroll to remember what they were
      // agreeing to — measured at 215px of a 612px panel, a third of it, before this.
      // THE SUBJECT NEVER COLLAPSES. Which order, where it is being redirected, who the
      // records go to, and whether restricted ones are included ARE the decision — not
      // background for it. All of this used to sit inside the <details> below while the
      // confirm button stayed visible outside it, so the honest description of the
      // default state was "confirm this return" with no way to see WHICH return without
      // first expanding a disclosure the button did not wait for. Presence is not
      // informed consent; the person has to be able to read what they are authorizing
      // without taking an extra action to reveal it.
      const subject = document.createElement('p');
      subject.className = 'confirm__subject';
      subject.setAttribute('data-3way-subject', '');
      subject.textContent = subjectLine(req);
      const detail = document.createElement('details');
      detail.className = 'confirm__detail';
      const summary = document.createElement('summary');
      summary.textContent = 'Why does this qualify?';
      const detailBody = document.createElement('p');
      // Only the LAST clause: the window/delivery clause that precedes it in
      // eligibility.ts's array is context for the verdict, not for the decision. The
      // verdict PATH moves up to the subject line; what stays here is the policy
      // reasoning behind it, which is genuinely secondary to the decision itself.
      detailBody.textContent = req.eligibility.because.at(-1) ?? '';
      detail.append(summary, detailBody);
      detail.addEventListener('toggle', () => pin());
      const note = document.createElement('p');
      note.setAttribute('data-3way-note', '');
      const btn = document.createElement('button');
      btn.setAttribute('data-3way-confirm', req.requestId);
      btn.textContent = 'Yes, confirm this';
      // Do NOT clear the affordance on click. A click is not authorization — the
      // authenticator is. Clear only once verification actually succeeded.
      btn.addEventListener('click', async (ev) => {
        // Layered assurance rule #1, ahead of every other check: an untrusted event is
        // refused REGARDLESS of which assurance level would otherwise apply. A
        // synthetic click (isTrusted === false) is exactly what a computer-use agent
        // produces driving this button directly — this stops it before pendingKey is
        // even set, so a genuine retry by the actual person right after is never
        // blocked by the untrusted attempt that preceded it.
        if (ev.isTrusted === false) {
          note.textContent = UNTRUSTED_CLICK_MESSAGE;
          return;
        }
        pendingKey = key;
        btn.disabled = true;
        btn.textContent = 'Verifying…';
        note.textContent = ''; // clear a previous attempt's failure text before retrying
        // onConfirm is contracted to resolve, never reject, with { ok } — but this is
        // the confirm button, and a rejection or a malformed resolution must not strand
        // it on "Verifying…" forever with nothing downstream to catch it. Treat either
        // as an ordinary failure rather than letting it throw past this handler.
        let result: { ok: true; data?: Record<string, unknown> } |
          { ok: false; reason: VerifyFailure };
        try {
          const r = await opts.onConfirm(req.requestId, tool,
            { orderId: req.orderId, itemId: req.itemId, reason: req.reason, scope: req.scope,
              address: req.address });
          if (r && typeof r === 'object' && (r as { ok?: unknown }).ok === true) {
            const data = (r as { data?: unknown }).data;
            result = { ok: true,
              ...(data && typeof data === 'object' ? { data: data as Record<string, unknown> } : {}) };
          } else if (r && typeof r === 'object' && (r as { ok?: unknown }).ok === false
                     && isKnownFailure((r as { reason?: unknown }).reason)) {
            result = r as { ok: false; reason: VerifyFailure };
          } else {
            result = { ok: false, reason: 'rejected' };
          }
        } catch {
          result = { ok: false, reason: 'rejected' };
        }
        if (pendingKey === key) pendingKey = null;
        // A resolution for a request that is no longer the one displayed — because it
        // was superseded — must be a silent no-op. Never mutate a box that belongs to
        // a different request than the one this ceremony started for.
        if (currentKey !== key) return;
        if (result.ok) {
          slot.replaceChildren();
          currentKey = null;
          if (result.data) {
            // Sensitive action data belongs in this local widget surface, never in a bus
            // entry: transcript prose is relayed to a third-party model.
            // textContent also keeps server-returned values from becoming markup.
            const completed = document.createElement('div');
            completed.className = 'confirm confirm--result';
            completed.setAttribute('data-3way-action-result', '');
            const completedTag = document.createElement('span');
            completedTag.className = 'confirm__tag';
            completedTag.textContent = 'Action completed';
            const payload = document.createElement('pre');
            payload.className = 'confirm__payload';
            payload.textContent = JSON.stringify(result.data, null, 2);
            completed.append(completedTag, payload);
            slot.append(completed);
            pin();
          }
          return;
        }
        // Never re-enable with the same label and no explanation — "nothing happened"
        // is indistinguishable from "your laptop has no Touch ID", and one of those is
        // unrecoverable. Say which.
        note.textContent = FAILURE_MESSAGE[result.reason];
        if (result.reason === 'no-authenticator' || result.reason === 'unsupported'
            || result.reason === 'action-failed' || result.reason === 'action-indeterminate') {
          btn.remove();
          return;
        }
        btn.disabled = false;
        btn.textContent = 'Yes, confirm this';
      });
      // Known-bad hardware is reported at mount, not discovered on first click.
      // If the probe has not resolved yet the value is undefined and we fall through to
      // the normal button — deliberately optimistic, because the reactive path below
      // handles no-authenticator correctly and a disabled button on a fast local check
      // would flicker. Known-bad is proactive; unknown is reactive. Both are covered.
      if (opts.authenticatorAvailable?.() === false) {
        // Layered assurance: known-bad hardware either refuses outright (the default,
        // and the only setting this project ships safe) or opts into a WEAKER,
        // honestly-labelled path — never silently one or the other. Only an explicit
        // 'trusted-click' selects it; anything else, including omission, refuses (same
        // fail-closed rule every other flag in this codebase follows).
        if (opts.onMissingAuthenticator === 'trusted-click') {
          note.textContent = TRUSTED_CLICK_NOTICE;
          box.append(tag, p, subject, detail, note, btn);
          slot.append(box);
          pin();
          return;
        }
        note.textContent = FAILURE_MESSAGE['no-authenticator'];
        box.append(tag, p, subject, detail, note);
        slot.append(box);
        pin();
        return;
      }
      box.append(tag, p, subject, detail, note, btn);
      slot.append(box);
      pin();
    },
    destroy() { off(); host.remove(); },
  };
}
