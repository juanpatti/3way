import { RETURN_REASONS, isReturnReason } from './types';
import type { Eligibility, Order, PolicyRules, ReturnReason } from './types';

const DAY = 86_400_000;

const deny = (...because: string[]): Eligibility => ({ eligible: false, path: 'denied', because });

/**
 * The single source of truth for whether something can be returned.
 * Deterministic by design: no model reasons about this. The visiting agent, the store
 * agent and the page all call this same function, so no two of them can reach different
 * verdicts on the same order.
 */
export function evaluateReturnEligibility(
  order: Order,
  itemId: string,
  reason: ReturnReason,
  rules: PolicyRules,
  now: number,
): Eligibility {
  // Before anything about this order is considered: an unrecognised reason code means we
  // were not asked a question this policy can answer, and the honest reply is to say so.
  // The alternative — what this used to do — was to let it fall past every explicit branch
  // below into the change-of-mind tail, which answers a DIFFERENT question and answers it
  // with total confidence. `wrong_item` (snake_case, the convention every tool name here
  // uses) came back "Final sale items are not returnable for change of mind" instead of
  // the clause-4 coverage it should have got. Never guess which clause a caller meant.
  if (!isReturnReason(reason)) {
    return deny(
      `"${String(reason)}" is not a return reason this policy recognises. ` +
      `Use one of: ${RETURN_REASONS.join(', ')}.`);
  }

  const item = order.items.find(i => i.itemId === itemId);
  if (!item) return deny(`Item ${itemId} is not part of order ${order.orderId}.`);
  if (order.deliveredAt === null) {
    return deny(`Order ${order.orderId} has not been delivered yet, so no return applies.`);
  }

  const days = Math.floor((now - order.deliveredAt) / DAY);
  const withinWindow = days <= rules.returnWindowDays;
  const finalSale = rules.finalSaleSkus.includes(item.sku);
  const because: string[] = [`Delivered ${days} days ago; the standard window is ${rules.returnWindowDays} days.`];
  if (finalSale) because.push(`${item.sku} is marked FINAL SALE.`);

  // Clause 3 — a defect is a warranty claim. Exempt from the window AND from final sale.
  if (reason === 'defect' && rules.warrantyExemptFromWindow) {
    because.push('A manufacturing defect is a warranty claim, which is exempt from the return window and unaffected by final sale.');
    return { eligible: true, path: 'warranty', because };
  }

  // Clause 4 — our error. Exempt from both.
  if (reason === 'wrong-item') {
    because.push('We shipped the wrong item, which is covered regardless of window or final sale.');
    return { eligible: true, path: 'return', because };
  }

  // Clause 5 — transit damage. Exempt from final sale, bound by the window.
  if (reason === 'damaged-in-transit') {
    if (!withinWindow) {
      because.push('Transit damage must be reported within the window, and this is past it.');
      return { eligible: false, path: 'denied', because };
    }
    because.push('Transit damage is covered regardless of final sale.');
    return { eligible: true, path: 'return', because };
  }

  // Clause 1 + 2 — change of mind. Bound by both. Reached only when `reason` is literally
  // 'changed-mind': the guard at the top of this function has already rejected everything
  // outside the union, and the three branches above have consumed the other three codes.
  // This used to be a bare fallthrough, which is how an unrecognised code got answered as
  // though someone had changed their mind.
  if (finalSale) {
    because.push('Final sale items are not returnable for change of mind.');
    return { eligible: false, path: 'denied', because };
  }
  if (!withinWindow) {
    because.push('The return window has closed for a change-of-mind return.');
    return { eligible: false, path: 'denied', because };
  }
  because.push('Within the window and not final sale, so a standard return applies.');
  return { eligible: true, path: 'return', because };
}

/**
 * Whether an order can still be cancelled or redirected. Deliberately NOT part of
 * evaluateReturnEligibility: the returns policy judges an item that has arrived, and has
 * nothing to say about one that hasn't. Routing cancellations through it produced exactly
 * the inversion you would expect — "has not been delivered yet, so no return applies"
 * refusing a cancellation at the one moment cancelling is most obviously reasonable.
 *
 * One rule, both actions: once the courier has handed it over, a cancellation is a return
 * and a redirect is too late. Before that, either is fine. No window, no final-sale
 * interaction — those are returns concepts.
 */
export function evaluateOrderChange(order: Order, action: 'cancel' | 'address-change'): Eligibility {
  const verb = action === 'cancel' ? 'cancelled' : 'redirected to a new address';
  if (order.deliveredAt !== null) {
    return deny(
      `Order ${order.orderId} has already been delivered, so it cannot be ${verb}. ` +
      `A delivered order is a returns question, not a fulfilment one.`);
  }
  return {
    eligible: true,
    path: 'order-change',
    because: [`Order ${order.orderId} has not been delivered yet, so it can still be ${verb}.`],
  };
}

/**
 * Whether the customer's own records can be released to this conversation.
 *
 * There is no policy question here — they are the customer's records and the session is
 * already theirs. The verdict is always yes, and this function exists for what it puts in
 * `because`: the confirm box renders the LAST clause, so this is where the person is told
 * what they are about to disclose, in the words they will read before touching the sensor.
 * A consent prompt that does not name what is being consented to is not consent.
 */
export function evaluateRecordsRelease(order: Order): Eligibility {
  return {
    eligible: true,
    path: 'disclosure',
    because: [
      `Order ${order.orderId} belongs to this signed-in customer.`,
      'Releasing these records shows the card type and its last four digits, the billing ' +
      'postcode, and the delivery address on file. Nothing else, and no full card number.',
    ],
  };
}

/**
 * Whether a set of visits can be released to a named recipient, and at what scope.
 *
 * The clinic's counterpart to evaluateReturnEligibility, and like it, deterministic: the
 * page, the clinic's agent and the patient's agent all call this one function, so none of
 * them can reach a different answer about what a release covers.
 *
 * The verdict is nearly always yes — they are the patient's own records. What this exists
 * for is the `because` chain, because modal.ts renders the LAST clause and that clause is
 * the sentence somebody reads immediately before touching a sensor. "Release records" is
 * not consent. "Send these four documents, including the counselling note, to Dr. Okafor"
 * is.
 */
export function evaluateDisclosure(
  visits: Array<{ visitId: string; categories: string[] }>,
  recipient: string,
  includeRestricted: boolean,
  restrictedCategories: readonly string[],
): Eligibility {
  if (visits.length === 0) return deny('No matching visits, so there is nothing to release.');
  if (!recipient.trim()) return deny('A release needs a named recipient. Nothing is sent to "whoever asks".');

  const all = visits.flatMap(v => v.categories);
  const restricted = [...new Set(all.filter(c => restrictedCategories.includes(c)))];
  const routine = [...new Set(all.filter(c => !restrictedCategories.includes(c)))];

  const because = [
    `${visits.length} visit${visits.length === 1 ? '' : 's'} selected: ${visits.map(v => v.visitId).join(', ')}.`,
  ];

  if (restricted.length > 0 && !includeRestricted) {
    // Clause 5. The restricted records are held back and SAID to be held back — a person
    // should never discover after the fact that a release was narrower than they thought,
    // any more than that it was wider.
    because.push(
      `Releasing ${routine.join(', ')} to ${recipient}. ` +
      `Holding back ${restricted.join(', ')} — restricted records need a request that names them.`);
    return { eligible: true, path: 'disclosure', because };
  }

  if (restricted.length > 0) {
    because.push(
      `Releasing ${routine.concat(restricted).join(', ')} to ${recipient}. ` +
      `This INCLUDES restricted records: ${restricted.join(', ')}.`);
    return { eligible: true, path: 'disclosure', because };
  }

  because.push(`Releasing ${routine.join(', ')} to ${recipient}.`);
  return { eligible: true, path: 'disclosure', because };
}
