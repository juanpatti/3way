// Plain-JS mirror of ../../../config/policy.ts — see the note at the top of seed.js in
// this same directory for why this file exists. POLICY_RULES must stay identical to the
// TypeScript source: the Worker's authoritative gate reads the real config/policy.ts,
// this copy only feeds what the page renders and what index.html hands to
// ThreeWay.mount(). If policy.ts changes, mirror the change here too.
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

export const POLICY_RULES = {
  returnWindowDays: 30,
  // The two clearance SKUs in the flagship catalogue. Warranty and fulfilment-error
  // protections remain available even when change-of-mind returns are not.
  finalSaleSkus: ['SKU-CLR-114', 'SKU-CLR-207'],
  warrantyExemptFromWindow: true,
  // One confirmation authorizes exactly one action. Completing a return IS the refund —
  // a separate issue_refund tool would need a second confirmation for the same decision,
  // and chaining them off one token cannot work (the token is single-use by design).
  requiresHumanDirect: ['confirm_return', 'cancel_order', 'change_address', 'disclose_order_records'],
  // Demo toggle. Flip to false to reproduce the click-forgeable design. Read by BOTH this
  // page and the Worker, so both must be redeployed together.
  requireHardwareConfirmation: true,
  // Layered assurance for a device the browser reports has no platform authenticator.
  // This deployment OPTS IN to 'trusted-click' so the showcase can complete in
  // ChatGPT's in-app browser, measured (docs/research/runtime-findings.md) to have no platform
  // authenticator at all. 'refuse' is still the setting to ship for anything real, and
  // the widget fails closed to webauthn-only whenever this flag is absent entirely, not
  // only when it reads 'refuse' — see config/policy.ts's matching comment. Read by
  // BOTH this page and the Worker, same as requireHardwareConfirmation above: this
  // page's copy is only what the CONFIRM BOX reads (a value the browser trusts, never
  // re-verified), while the Worker's own /api/trusted-click reads its OWN import of
  // config/policy.ts independently and is gated further by /api/session — which
  // narrows who can reach /api/trusted-click but does not close it (worker/src/
  // index.ts). Never change this value here without changing config/policy.ts's
  // identical field and redeploying both, in the same release.
  onMissingAuthenticator: 'trusted-click',
};
