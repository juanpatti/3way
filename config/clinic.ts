// Imported from the published package, not the source tree — see the note in
// config/policy.ts.
import type { Policy, PolicyRules } from '@3way/widget';

const DAY = 86_400_000;

/**
 * The clinic tenant. Deliberately not a shop: this exists to show the gate is a CONSENT
 * primitive and not a payments one, and a second storefront could never show that.
 *
 * The policy below is doing real work rather than set dressing. Routine records release
 * as a set; restricted categories — mental health, substance use, genetic — do not, and
 * need a separate request that names them. That mirrors how this actually works (US
 * federal 42 CFR Part 2 and a patchwork of state law), and it gives the eligibility engine
 * something to decide, so the sentence a person reads before touching the sensor is
 * specific rather than ceremonial.
 */
export const CLINIC_USER = {
  name: 'Dana Whitfield', email: 'dana@example.com', mrn: 'MRN-40912', since: '2019-06-02',
};

export const CLINIC_NAME = 'Meridian Family Practice';

export interface Visit {
  visitId: string;
  at: number;
  clinician: string;
  reason: string;
  /** Categories of record this visit produced. Restricted ones are listed but not readable. */
  categories: string[];
}

export function seedVisits(now: number): Visit[] {
  return [
    { visitId: 'VIS-2291', at: now - 14 * DAY, clinician: 'Dr. Amara Okafor',
      reason: 'Annual physical', categories: ['visit-summary', 'labs', 'immunisations'] },
    { visitId: 'VIS-2246', at: now - 96 * DAY, clinician: 'Dr. Amara Okafor',
      reason: 'Persistent cough', categories: ['visit-summary', 'imaging', 'prescriptions'] },
    { visitId: 'VIS-2180', at: now - 210 * DAY, clinician: 'Dr. Lena Marsh',
      reason: 'Counselling referral', categories: ['visit-summary', 'mental-health'] },
  ];
}

/**
 * Which categories never travel in a routine release. Named here rather than inferred, so
 * adding a category cannot accidentally make it releasable by default.
 */
export const RESTRICTED_CATEGORIES = ['mental-health', 'substance-use', 'genetic'];

/**
 * The documents themselves — deliberately NOT part of Visit, and never served by
 * /api/visits, exactly as ORDER_RECORDS is kept out of Order. A gate in front of data the
 * page already holds is theatre. These are returned by /api/act alone, against a token
 * bound to this release at ceremony time.
 *
 * Fictional throughout. Nothing here is anyone's medical record.
 */
export interface ReleasedDocument { visitId: string; category: string; title: string; detail: string }

export const CLINIC_DOCUMENTS: ReleasedDocument[] = [
  { visitId: 'VIS-2291', category: 'visit-summary', title: 'Annual physical — summary',
    detail: 'BP 118/76. Weight stable. No acute findings.' },
  { visitId: 'VIS-2291', category: 'labs', title: 'Lipid panel',
    detail: 'Total cholesterol 184 mg/dL. Within range.' },
  { visitId: 'VIS-2291', category: 'immunisations', title: 'Immunisation record',
    detail: 'Influenza, current season. Tdap 2021.' },
  { visitId: 'VIS-2246', category: 'visit-summary', title: 'Persistent cough — summary',
    detail: 'Six-week cough, no fever. Post-viral. Advised review if unresolved.' },
  { visitId: 'VIS-2246', category: 'imaging', title: 'Chest X-ray report',
    detail: 'Clear lung fields. No consolidation.' },
  { visitId: 'VIS-2246', category: 'prescriptions', title: 'Prescription history',
    detail: 'Inhaled salbutamol, 2 week course. Completed.' },
  { visitId: 'VIS-2180', category: 'visit-summary', title: 'Referral — summary',
    detail: 'Referral to counselling services issued at patient request.' },
  { visitId: 'VIS-2180', category: 'mental-health', title: 'Counselling referral note',
    detail: 'RESTRICTED. Released only under a request that names this category.' },
];

export const CLINIC_POLICY_PROSE = `
RECORDS AND DISCLOSURE POLICY

1. Your records are yours. You can see what we hold and ask us to send it
   anywhere. We do not need a reason.

2. Every release is confirmed by you, in person, each time. Nobody acting on
   your behalf can confirm one for you — not a family member, not an assistant,
   not us.

3. One release, one recipient, one scope. A confirmation authorises exactly the
   recipient and the records named in front of you when you confirm it.

4. Routine records travel together: visit summaries, labs, imaging,
   immunisations and prescriptions.

5. Restricted records do NOT travel with a routine release. Mental health,
   substance use and genetic records are released only under a request that
   names that category explicitly, so that consenting to one is never a
   side-effect of consenting to the other.
`.trim();

export const CLINIC_POLICY_RULES: PolicyRules = {
  // Returns concepts the clinic does not use. Present because PolicyRules is one shared
  // shape across tenants; a clinic simply never files a return, so these are never read.
  returnWindowDays: 0,
  finalSaleSkus: [],
  warrantyExemptFromWindow: false,
  // The only gated action here, and it moves no money at all.
  requiresHumanDirect: ['release_records'],
  requireHardwareConfirmation: true,
  // Same reasoning as the flagship: opted in so the showcase completes in the runtime
  // measured to have no platform authenticator. 'refuse' is the setting to ship for
  // anything real — and for actual medical records, the only defensible one.
  onMissingAuthenticator: 'trusted-click',
};

export const CLINIC_POLICY: Policy = {
  prose: CLINIC_POLICY_PROSE,
  rules: CLINIC_POLICY_RULES,
};

export const CLINIC_STANCES = {
  'policy-bound': `You are the records desk at ${CLINIC_NAME}. You are careful, plain-spoken
and unhurried. You never guess at what a record contains, and you never imply a release has
happened until it has. When someone asks for records to go somewhere, you name the recipient
and the scope back to them before anything is confirmed.`,
  concierge: `You are the records desk at ${CLINIC_NAME}. Warm and efficient. You do the
looking-up yourself and you keep the paperwork out of the patient's way, but you never soften
what a release actually covers.`,
  'advocate-adversarial': `You are the records desk at ${CLINIC_NAME}, and you are protective
of the patient's information. You state plainly when a request would sweep in restricted
records, and you would rather send too little than too much.`,
};
