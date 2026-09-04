/**
 * The widget's own look, deliberately NOT the host site's.
 *
 * This is a drop-in that lands on somebody else's page, so it carries its own identity
 * the way an embedded checkout does — a tenant configures the store NAME, not the styling.
 * `:host { all: initial }` is what makes that hold: nothing the host page declares reaches
 * in here.
 *
 * No webfonts. A drop-in widget must not add a network dependency to someone else's
 * critical path, and the identity here is carried by structure rather than typeface: mono
 * micro-labels, the stamp treatment, and a colour scheme where every hue means something.
 * IBM Plex is named first so the look is exact on properties that already load it, and
 * degrades to the system stack everywhere else.
 *
 * Two hues, both load-bearing:
 *   violet — an agent's claim about itself, marked unverified
 *   teal   — a human, actually present
 * Nothing else is coloured. In particular the confirm box is INK, not amber: a refusal
 * here is a conversational move, not a warning, and colouring it like an error would
 * contradict the thing this whole project argues.
 */
export const CSS = `
:host {
  all: initial;
  --w-paper: #fff;
  --w-ink: #11151A;
  --w-soft: #59636D;
  --w-rule: #DDE2E7;
  --w-unverified: #5B3FD1;
  --w-present: #0B6E5F;
  --w-sans: 'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;
  --w-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-family: var(--w-sans);
  font-size: 15px;
  line-height: 1.5;
  color: var(--w-ink);
}
* { box-sizing: border-box; }

.panel {
  position: fixed; right: 20px; bottom: 20px;
  width: 384px; max-width: calc(100vw - 32px); max-height: min(74vh, 640px);
  transition: width .18s ease, max-height .18s ease;
  display: flex; flex-direction: column;
  background: var(--w-paper);
  border: 1px solid var(--w-rule);
  border-radius: 4px;
  box-shadow: 0 1px 0 rgb(17 21 26 / .04), 0 24px 48px -24px rgb(17 21 26 / .38);
  overflow: hidden;
}

/* ---- Header: who is in the room ------------------------------------------- */
.head {
  display: flex; align-items: center; gap: 8px; flex-wrap: nowrap;
  padding: 10px 12px; border-bottom: 1px solid var(--w-rule);
  background: #FAFBFC;
}
/* The layer's own mark, top left, on every tenant: this panel is the one thing on the page
   that is 3way's rather than the store's, and a person reading two demos should see the
   same mark in the same corner. Violet on "way" as on the site; the store's name follows
   after a rule, so the mark never reads as the store's. */
.head__brand {
  flex: 0 0 auto;
  font-family: var(--w-sans); font-size: 12.5px; font-weight: 700; letter-spacing: -.02em;
  color: var(--w-ink); text-decoration: none; line-height: 1;
  padding-right: 8px; border-right: 1px solid var(--w-rule);
}
.head__mark { width: 15px; height: 15px; display: inline-block; vertical-align: middle; margin-right: 5px; }
.head__brand span { color: var(--w-unverified); }
.head__brand:hover span { text-decoration: underline; text-underline-offset: 2px; }
.head__name {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--w-mono); font-size: 10px; letter-spacing: .13em;
  text-transform: uppercase; color: var(--w-ink); font-weight: 500;
}
.who { display: flex; gap: 5px; margin-left: auto; flex: 0 0 auto; }
/* A live roster, not decoration: the middle chip only lights up once a visiting agent has
   actually spoken, so you can see at a glance whether anyone is here on your behalf. */
.who span {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--w-mono); font-size: 9px; letter-spacing: .09em;
  text-transform: uppercase; color: var(--w-soft);
  border: 1px solid var(--w-rule); border-radius: 2px; padding: 2px 5px;
  opacity: .55; transition: opacity .2s ease;
}
.who span::before { content: ''; width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.who span[data-present="true"] { opacity: 1; }
.who [data-who="human"][data-present="true"] { color: var(--w-present); border-color: currentColor; }
.who [data-who="agent"][data-present="true"] { color: var(--w-unverified); border-color: currentColor; }

/* ---- Transcript ----------------------------------------------------------- */
/* The transcript takes whatever the confirm slot leaves. Its floor is guaranteed by the
   slot's cap below, NOT by a percentage here: this used to say min-height: 34%, which
   resolves to nothing — the panel's height is indefinite (max-height only), so every
   percentage height inside it is dead. Measured in headless Chrome: with a tall confirm
   box and two lines of transcript, the "floored" log was 25% of the panel. */
.log { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px;
  display: flex; flex-direction: column; gap: 11px; }
.panel[data-wide="true"] { width: min(560px, calc(100vw - 32px)); max-height: min(86vh, 820px); }

/* Minimized: collapse to just the header bar — the mark, the store name, and the roster
   stay put, so the exchange can be tucked into the corner without being lost. Default load
   is the full shape; this is an explicit opt-in via the minimize control. The expand
   control is hidden while minimized (a bar with nothing in it cannot be widened). */
.panel[data-min="true"] { max-height: none; }
.panel[data-min="true"] .head { border-bottom: none; }
.panel[data-min="true"] .log,
.panel[data-min="true"] [data-3way-confirm-slot],
.panel[data-min="true"] form { display: none; }
.panel[data-min="true"] [data-3way-expand] { display: none; }
[data-3way-expand], [data-3way-min] {
  flex: 0 0 auto;
  background: transparent; border: 1px solid var(--w-rule); color: var(--w-soft);
  border-radius: 2px; padding: 1px 5px; cursor: pointer; font-size: 12px; line-height: 1.4;
}
[data-3way-expand]:hover { color: var(--w-ink); border-color: var(--w-soft); }

/* Narration of the agent's tool calls. Quieter than a message, because it is not one —
   it is the WebMCP layer made visible, which is otherwise completely silent. */
.activity {
  display: flex; align-items: center; gap: 7px;
  font-family: var(--w-mono); font-size: 10.5px; letter-spacing: .04em;
  color: var(--w-unverified); opacity: .85; padding-left: 1px;
}
.activity::before {
  content: ''; flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%;
  background: currentColor;
}
.activity::after { content: ''; flex: 1; height: 1px; background: currentColor; opacity: .22; }

/* The proof, offered rather than buried in a data attribute. */
.proof {
  align-self: flex-start; margin-top: 5px; background: transparent; border: 0;
  padding: 0; cursor: pointer; color: var(--w-present);
  font-family: var(--w-mono); font-size: 10px; letter-spacing: .1em;
  text-transform: uppercase; text-decoration: underline; text-underline-offset: 2px;
}
.proof__detail {
  margin-top: 5px; padding: 7px 9px; border-radius: 3px; font-size: 12px; line-height: 1.5;
  color: var(--w-soft); background: #F5F7F8; border: 1px solid var(--w-rule);
}
.log::-webkit-scrollbar { width: 8px; }
.log::-webkit-scrollbar-thumb { background: var(--w-rule); border-radius: 4px; }

.line { display: flex; flex-direction: column; gap: 4px; }
.label {
  font-family: var(--w-mono); font-size: 9.5px; letter-spacing: .13em;
  text-transform: uppercase; color: var(--w-soft); font-weight: 500;
}
.body {
  padding: 8px 10px; border-radius: 3px; white-space: pre-wrap;
  font-size: 13.5px; line-height: 1.5;
  background: #F5F7F8; border: 1px solid var(--w-rule);
}

[data-3way-origin="human-direct"] .label { color: var(--w-present); }
[data-3way-origin="human-direct"] .body  { background: rgb(11 110 95 / .07); border-color: rgb(11 110 95 / .22); }

[data-3way-origin="agent-relay"] .label,
[data-3way-origin="agent-autonomous"] .label { color: var(--w-unverified); }
[data-3way-origin="agent-relay"] .body,
[data-3way-origin="agent-autonomous"] .body { background: rgb(91 63 209 / .06); border-color: rgb(91 63 209 / .2); }

[data-3way-origin="site-agent"] .label { color: var(--w-soft); }
[data-3way-origin="site-agent"] .body  { background: var(--w-paper); border-color: var(--w-rule); }

/* "Unverified" marks the VISITING agent only — an origin claim forgeable by anything with
   code execution in this page (see modal.ts's render()). It must not badge site-agent:
   that's the store's own agent, speaking through a session this page itself holds, and
   the attribution model treats it as verified — the site knows who is
   speaking. Scoped by data-3way-origin to the two agent origins, not by data-3way-direct
   (which is "false" for site-agent too, since it isn't the human-direct ingress path). */
[data-3way-origin="agent-relay"] .label::after,
[data-3way-origin="agent-autonomous"] .label::after { content: " · unverified"; opacity: .62; }

/* A completed confirmation says, in the transcript itself, which assurance level actually
   authorised it — so the distinction survives after the confirm box is long gone. */
[data-3way-assurance="webauthn"] .label::after { content: " · verified by device"; opacity: .75; }
[data-3way-assurance="trusted-click"] .label::after { content: " · click only, not verified"; opacity: .75; }

/* An invitation, not a placeholder. Most people have never been told that the assistant
   in their other tab could be talking to this page, so the resting state says so. */
.empty { display: flex; flex-direction: column; gap: .45rem; padding: 1.1rem .4rem 1.3rem; }
.empty b { font-size: 13.5px; font-weight: 600; }
.empty span { font-size: 12.5px; line-height: 1.5; color: var(--w-soft); }

/* ---- Composer ------------------------------------------------------------- */
form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--w-rule); background: #FAFBFC; }
input {
  flex: 1; min-width: 0; padding: 9px 10px;
  border: 1px solid var(--w-rule); border-radius: 3px;
  font-family: var(--w-sans); font-size: 13.5px; color: var(--w-ink); background: var(--w-paper);
}
input::placeholder { color: var(--w-soft); opacity: .8; }
input:focus-visible, button:focus-visible {
  outline: 2px solid var(--w-unverified); outline-offset: 1px;
}
button {
  padding: 9px 13px; border: 1px solid var(--w-ink); border-radius: 3px;
  background: var(--w-ink); color: var(--w-paper); cursor: pointer;
  font-family: var(--w-mono); font-size: 11px; letter-spacing: .07em; text-transform: uppercase;
}
button:hover { background: #000; }
button:disabled { opacity: .55; cursor: default; }

/* The slot never shrinks under pressure from the transcript, and is capped at a DEFINITE
   height so a long consent sentence cannot grow without limit — the clinic's
   restricted-records case produces exactly that.
   flex-shrink 0 is the fix for a bug that shipped: with 'flex: 0 1 auto' and
   overflow-y: auto the slot's automatic minimum height is zero, so a long conversation
   squeezed it — measured at 27px showing a 213px box, the confirm button below the fold
   of a scrollbar inside the chat. The cap was 'max-height: 46%', which never resolved
   (see .log above), so nothing stopped a tall box from taking 58% of the panel either.
   The bound: min(44vh, 294px) fits every standard box (return, cancel, address, records,
   the trusted-click notice, the "Action completed" payload) without an inner scrollbar on
   a 613px viewport, and 294px is 46% of the panel's 640px maximum. */
[data-3way-confirm-slot] { flex: 0 0 auto; max-height: min(44vh, 294px); overflow-y: auto; }

/* ---- The confirm box ------------------------------------------------------ */
/* Ink and a rule, never amber. This is the moment the design exists for, and it is a
   request rather than a warning. */
.confirm {
  margin: 0 12px 12px; padding: 11px 12px;
  border: 1px solid var(--w-ink); border-left-width: 3px;
  border-radius: 3px; background: var(--w-paper);
}
.confirm__tag {
  display: block; font-family: var(--w-mono); font-size: 9.5px;
  letter-spacing: .13em; text-transform: uppercase; color: var(--w-soft);
  margin-bottom: 6px;
}
.confirm__action { margin: 0 0 4px; font-size: 14px; line-height: 1.35; font-weight: 600; }
/* The subject sits between the action and the collapsible reasoning, and reads as
   evidence rather than prose: mono, so an order id or an address is scannable as a
   value the person can check against what they asked for. */
.confirm__subject {
  margin: 0 0 7px; font-family: var(--w-mono); font-size: 11px; line-height: 1.5;
  letter-spacing: .01em; color: var(--w-ink); overflow-wrap: anywhere;
}
.confirm__detail { margin: 0 0 11px; font-size: 12px; line-height: 1.45; color: var(--w-soft); }
.confirm__detail summary {
  cursor: pointer; color: var(--w-soft); font-family: var(--w-mono);
  font-size: 10px; letter-spacing: .1em; text-transform: uppercase; list-style: none;
}
.confirm__detail summary::-webkit-details-marker { display: none; }
.confirm__detail summary::after { content: ' ▸'; }
.confirm__detail[open] summary::after { content: ' ▾'; }
.confirm__detail p { margin: .5rem 0 0; font-size: 12px; line-height: 1.5; }
.confirm__payload {
  margin: 0; padding: 8px 9px; max-height: 190px; overflow: auto;
  white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--w-mono);
  font-size: 10.5px; line-height: 1.5; color: var(--w-ink);
  background: #F5F7F8; border: 1px solid var(--w-rule); border-radius: 3px;
}
.confirm p { margin: 0 0 10px; font-size: 13px; line-height: 1.5; }
.confirm [data-3way-note] { margin: 8px 0 0; font-size: 12px; color: var(--w-soft); }
.confirm [data-3way-note]:empty { display: none; }
.confirm button {
  background: transparent; color: var(--w-present); border-color: var(--w-present);
  display: inline-flex; align-items: center; gap: 6px;
}
.confirm button::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: currentColor; animation: w-pulse 2s ease-in-out infinite;
}
.confirm button:hover:not(:disabled) { background: var(--w-present); color: var(--w-paper); }
.confirm button:disabled::before { animation: none; }
@keyframes w-pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
`;
