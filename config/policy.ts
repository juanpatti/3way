// Imported from the published package (`@3way/widget`), not from `../packages/widget/src`.
// Workspace resolution makes this identical to importing the source tree in-repo, but it
// means this file only ever sees the same public types an external adopter gets — the
// thing that makes "swap config/ and nothing else" a claim this repo actually tests on
// itself, rather than one that happens to work here because of a relative path.
import type { PolicyRules } from '@3way/widget';

export const POLICY_PROSE = `
RETURNS AND WARRANTY POLICY

1. Standard returns. Items may be returned within 30 days of delivery for a full
   refund. Condition is assessed when the item arrives back with us: items that are
   worn, used, or missing original packaging may receive a partial refund or be
   returned to you.

2. Final sale. Items marked FINAL SALE are not returnable for change of mind.
   Final sale status does NOT limit your rights under clauses 3 or 4.

3. Manufacturing defects. An item that fails due to a manufacturing defect is a
   WARRANTY claim, not a return. Warranty claims are NOT subject to the 30-day
   window and are NOT affected by final sale status.

4. Our error. If we shipped the wrong item, we cover it regardless of the 30-day
   window and regardless of final sale status.

5. Transit damage. Items damaged in transit are covered regardless of final sale
   status, but must be reported within the 30-day window.

6. Confirmation. A refund is only issued after the customer confirms it
   themselves. An assistant acting on the customer's behalf may prepare and
   propose a refund but cannot confirm it.
`.trim();

export const POLICY_RULES: PolicyRules = {
  returnWindowDays: 30,
  // The two clearance SKUs in the flagship catalogue. Warranty and fulfilment-error
  // protections remain available even when change-of-mind returns are not.
  finalSaleSkus: ['SKU-CLR-114', 'SKU-CLR-207'],
  warrantyExemptFromWindow: true,
  // One confirmation authorizes exactly one action. Completing a return IS the refund —
  // a separate issue_refund tool would need a second confirmation for the same decision,
  // and chaining them off one token cannot work (the token is single-use by design).
  // disclose_order_records is here for a different reason than the other three: it moves
  // no money at all. It exists to show the gate is a CONSENT primitive, not a payments
  // one — releasing the card's last four digits and the delivery address on file needs
  // the person present exactly as a refund does.
  requiresHumanDirect: ['confirm_return', 'cancel_order', 'change_address', 'disclose_order_records'],
  // Demo toggle. Flip to false to reproduce the click-forgeable design.
  requireHardwareConfirmation: true,
  // Layered assurance for a device the browser reports has no platform authenticator —
  // NOT the same knob as requireHardwareConfirmation above. This deployment OPTS IN to
  // 'trusted-click' so the showcase can complete in ChatGPT's in-app browser, measured
  // (docs/research/runtime-findings.md) to have no platform authenticator at all. 'refuse' is
  // still the setting to ship for anything real, and the widget fails closed to
  // webauthn-only whenever this flag is absent entirely, not only when it reads
  // 'refuse'. See PolicyRules's own doc comment (packages/widget/src/types.ts) for what
  // 'trusted-click' does — and, stated there plainly, the severity of turning it on:
  // /api/session narrows who can reach /api/trusted-click, it does not close it.
  onMissingAuthenticator: 'trusted-click',
};
