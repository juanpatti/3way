import {
  createGateway, publicEntry, withGatewayDestroy, type GatewayDeps, type ToolRegistry,
} from './tools';
import { evaluateDisclosure } from './eligibility';
import type { PendingRequest, Tool } from './types';

/**
 * The clinic's registry: a records desk, not a shop.
 *
 * This file exists to make one claim checkable rather than asserted. Everything that
 * matters here — the shared transcript, stamped origins, the refusal shape, await_reply,
 * and a gate only a person can pass — comes from the same gateway the shop uses. What
 * differs is only the domain: visits and disclosures instead of orders and refunds.
 *
 * Which is the point. If the layer were really about shopping, a clinic could not be built
 * on it without the seams showing.
 *
 * The gated action moves no money at all. It sends records to a named third party, and
 * that is a strictly harder consent problem than a refund: a refund you can reverse.
 */
export interface ClinicVisit {
  visitId: string;
  at: number;
  clinician: string;
  reason: string;
  categories: string[];
}

export interface ClinicDataSource {
  listVisits(): Promise<ClinicVisit[]>;
  getVisit(visitId: string): Promise<ClinicVisit | null>;
}

export interface ClinicToolDeps extends GatewayDeps {
  data: ClinicDataSource;
  /** Categories that never travel in a routine release (config/clinic.ts). */
  restrictedCategories: readonly string[];
}

const obj = (props: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties: props, required } as Record<string, unknown>);
const str = (description: string) => ({ type: 'string', description });

export function createClinicTools(deps: ClinicToolDeps): ToolRegistry {
  const { bus, data, policy, newRequestId, onConfirmationNeeded, restrictedCategories, siteOrigin } = deps;
  const { pending, gated, ro, destroy, hasCompleted } = createGateway(deps);

  const tools: Tool[] = [
    {
      name: 'list_my_visits',
      activity: 'looked up your visits',
      description: "List the signed-in patient's visits, with the categories of record each produced.",
      annotations: ro,
      inputSchema: obj({}),
      execute: async () => ({ visits: await data.listVisits() }),
    },
    {
      name: 'get_visit',
      activity: 'opened a visit',
      description:
        'Details of one visit: who was seen, why, and which categories of record exist. ' +
        'This does NOT return the records themselves — nothing does, until a release has ' +
        'been confirmed by the patient in person.',
      annotations: ro,
      inputSchema: obj({ visitId: str('Visit id, e.g. "VIS-2291", from list_my_visits.') }, ['visitId']),
      execute: async i => ({ visit: await data.getVisit(String(i.visitId ?? '')) }),
    },
    {
      name: 'get_records_policy',
      activity: 'read the records policy',
      description: 'The full records and disclosure policy text.',
      annotations: ro,
      inputSchema: obj({}),
      execute: async () => ({ policy: policy.prose }),
    },
    {
      name: 'get_conversation',
      description: 'The conversation so far, with who said each line.',
      annotations: ro,
      inputSchema: obj({}),
      execute: async () => ({ entries: bus.all().map(publicEntry) }),
    },
    {
      name: 'send_message',
      description:
        'Say something into the shared conversation. The patient sees it. Set intent to ' +
        '"relay" when you are passing on what they told you rather than speaking for yourself.',
      inputSchema: obj({
        text: str('What to say.'),
        intent: { type: 'string', enum: ['relay', 'own'], description: 'Defaults to "own".' },
      }, ['text']),
      async execute(i, ctx) {
        if (ctx.origin === 'site-agent') {
          return { ok: false, message: 'send_message is not available to the clinic agent.' };
        }
        const origin = i.intent === 'relay' ? 'agent-relay' : 'agent-autonomous';
        const entry = bus.append({ origin, text: String(i.text ?? '') });
        return {
          ok: true, id: entry.id,
          hint: 'A reply will not be pushed to you. Call await_reply to wait for it.',
        };
      },
    },
    {
      name: 'provide_context',
      description:
        'Front-load what you already know about the patient and what they need, so the ' +
        'clinic does not have to ask. Call this first, before anything else.',
      inputSchema: obj({
        summary: str('One or two sentences on what the patient wants.'),
        data: { type: 'object', description: 'Structured facts: dates, recipient, what was tried.' },
      }, ['summary']),
      async execute(i, ctx) {
        if (ctx.origin === 'site-agent') {
          return { ok: false, message: 'provide_context is not available to the clinic agent.' };
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
      name: 'request_records_disclosure',
      activity: 'prepared a records release',
      description:
        'Propose sending records to a named recipient. Always allowed: this only creates a ' +
        'pending request and tells you exactly what it would cover. It sends nothing. '
        + 'If you do not know who the recipient is, call it anyway: it will tell you what to '
        + 'ask the patient rather than guess, and guessing a recipient is the one failure a '
        + 'records system must not have. ' +
        'Restricted records (mental health, substance use, genetic) can never be released ' +
        'through this tool — an agent cannot include them whatever it asks, so consenting ' +
        'to routine records is never how somebody consents to those.',
      inputSchema: obj({
        visitIds: { type: 'array', items: { type: 'string' }, description: 'Visit ids to release.' },
        recipient: str('Who receives them, named. E.g. "Dr. Amara Okafor, Meridian Family Practice".'),
        include_restricted: {
          type: 'boolean',
          description: 'Rejected. Restricted records cannot be released through this tool; setting this true refuses the request.',
        },
      }, ['visitIds', 'recipient']),
      async execute(i, ctx) {
        const ids = Array.isArray(i.visitIds) ? i.visitIds.map(String) : [];
        const found = (await Promise.all(ids.map(id => data.getVisit(id))))
          .filter((v): v is ClinicVisit => v !== null);
        const recipient = String(i.recipient ?? '').trim();

        /**
         * The OTHER kind of human-in-the-loop refusal, and the one the conventions were
         * missing: not "a human must authorise this" but "a human is the only one who
         * knows this". The clinic cannot infer a recipient — there is no correct guess,
         * and guessing is the failure mode worth designing out of a records system.
         *
         * Shaped like the confirmation refusal on purpose: ok:false first so an agent that
         * understands nothing else treats it as "did not happen", a discriminator, prose
         * for the person, and a hint for the machine. The hint names await_reply because
         * this is precisely the moment an agent otherwise asks a question and then ends its
         * turn, leaving the answer unread.
         */
        const needs = (question: string, message: string) => ({
          ok: false as const,
          needsInformation: true as const,
          origin: siteOrigin,
          question,
          message,
          agentHint: 'Ask the patient this in the conversation with send_message, then call '
            + 'await_reply to wait for their answer. Nothing is pushed to you, so ending your '
            + 'turn here means never hearing it.',
        });

        if (!found.length) {
          return needs(
            'Which visits should go? You can say a date, a reason, or "the last two".',
            'No visits matched, so there is nothing to release yet.');
        }
        if (!recipient) {
          return needs(
            'Who should the records go to? I need a name, and their practice if you have it.',
            'A release needs a named recipient. Nothing is sent to "whoever asks".');
        }

        // A completed release cannot be re-filed in the same session. The same bug shipped
        // in the shop: after a release completed, the agent re-filed the identical request,
        // a fresh confirm box appeared, and confirming it would have released the same
        // records to the same recipient twice. In memory and per gateway on purpose, so a
        // reload re-runs the seeded demo (see `completed` in createGateway); a genuine
        // second release needs a second full ceremony.
        const subject = found.map(v => v.visitId).join('+');
        if (hasCompleted('disclosure', subject, recipient)) {
          return { ok: false, message:
            `Those records have already been released to ${recipient} in this session. ` +
            `A new release would need you to confirm it again on your device.` };
        }

        // Restricted records cannot be released through an agent-prepared disclosure — a
        // hard limit, not a scope an agent can widen. Refuse the attempt outright; the
        // Worker excludes restricted regardless, and evaluateDisclosure below is only ever
        // asked for routine records.
        if (i.include_restricted === true) {
          return { ok: false, message:
            'Restricted records (mental health, substance use, genetic) cannot be released ' +
            'through this disclosure. That is a hard limit here — an agent cannot include ' +
            'them whatever it asks. If the patient needs them, they must be requested separately.' };
        }
        const eligibility = evaluateDisclosure(found, recipient, false, restrictedCategories);
        if (!eligibility.eligible) return { ok: false, eligibility, message: eligibility.because.join(' ') };

        const requestId = newRequestId();
        const req: PendingRequest = {
          requestId, kind: 'disclosure',
          // orderId carries the subject of the request across the shared machinery. Here
          // that is the set of visits; the field is named for the shop because the shop
          // came first, and renaming it would touch the Worker's token binding for no gain.
          orderId: subject,
          // itemId carries the RECIPIENT and scope the breadth, because those are the two
          // things the ceremony must be bound to: a release is to one named party at one
          // named breadth, and both were on screen when the patient confirmed.
          itemId: recipient,
          reason: null,
          requestedBy: ctx.origin,
          scope: 'routine',
          address: recipient,
          eligibility,
        };
        pending.set(requestId, req);
        onConfirmationNeeded?.(req, 'release_records');
        return { ok: true, requestId, eligibility, recipient };
      },
    },
    {
      name: 'await_reply',
      activity: 'is waiting for a reply',
      description:
        'Wait here until someone else says something. Nothing is pushed to you otherwise: ' +
        'this page can only answer calls you make. Call this to wait instead of ending ' +
        'your turn or polling. Returns as soon as there is anything new, or after a few ' +
        'seconds with nothing_new: true. Safe to call at any time.',
      annotations: ro,
      inputSchema: obj({
        timeout_ms: { type: 'number', description: 'Default 25000, max 30000.' },
      }),
      async execute(i, ctx) {
        const asked = typeof i.timeout_ms === 'number' && Number.isFinite(i.timeout_ms) ? i.timeout_ms : 25_000;
        const timeout = Math.min(Math.max(asked, 1_000), 30_000);
        if (bus.since(ctx.cursor).entries.length > 0) return { waited_ms: 0, nothing_new: false };
        const started = deps.now();
        const settled = await new Promise<boolean>(resolve => {
          let done = false;
          const finish = (v: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            unsubscribe();
            resolve(v);
          };
          const unsubscribe = bus.subscribe(() => finish(true));
          const timer = setTimeout(() => finish(false), timeout);
        });
        return { waited_ms: deps.now() - started, nothing_new: !settled };
      },
    },
    gated('release_records', 'disclosure',
      'Send the records in a pending disclosure to the recipient it names.',
      'Records released.'),
  ];
  return withGatewayDestroy(tools, destroy);
}
