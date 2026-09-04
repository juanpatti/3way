import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { POLICY_RULES } from '../../config/policy';
import { CLINIC_POLICY_RULES } from '../../config/clinic';

/**
 * Regression tests for /api/act — the authoritative gate. No miniflare, no wrangler: this
 * calls the exported `fetch` handler directly against a mock KVNamespace, which is enough
 * to exercise every branch of the gate itself. What it CANNOT cover is written up at the
 * bottom of this file, not left implicit.
 */

interface StoredTokenRecord {
  requestId: string;
  tool: string;
  deviceId: string;
  tenant?: string;
  orderId?: string;
  itemId?: string;
  reason?: string;
  scope?: string;
  address?: string;
  used: boolean;
  result?: Record<string, unknown>;
  resultStatus?: number;
}

/**
 * Minimal KVNamespace double. Deliberately does NOT model two things real Workers KV
 * does: TTL/expiry (a `put` here never expires) and eventual consistency (a `put` here is
 * immediately visible to every subsequent `get`, with no replication lag). Both are
 * called out in the "cannot cover" note below — a test passing against this mock is not
 * proof the same sequence is safe against a `get` racing a not-yet-propagated `put`.
 */
class MockKV {
  store = new Map<string, string>();
  gets: string[] = [];
  puts: string[] = [];
  private failPutKeys: Set<string>;
  private failGetKeys: Set<string>;

  constructor(failPutKeys: string[] = [], failGetKeys: string[] = []) {
    this.failPutKeys = new Set(failPutKeys);
    this.failGetKeys = new Set(failGetKeys);
  }

  async get(key: string, type?: string): Promise<unknown> {
    this.gets.push(key);
    if (this.failGetKeys.has(key)) throw new Error(`simulated KV.get failure for ${key}`);
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }

  async put(key: string, value: string): Promise<void> {
    this.puts.push(key);
    if (this.failPutKeys.has(key)) throw new Error(`simulated KV.put failure for ${key}`);
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  seedToken(token: string, record: StoredTokenRecord): void {
    this.store.set(`3way:tok:${token}`, JSON.stringify(record));
  }
}

// Frozen for the same reason worker/test/tenant.test.ts freezes it: the confirm_return
// eligibility checks below are relative to "now" (ORD-1043's delivered-35-days-ago claim
// only holds against a fixed reference point), and a frozen clock keeps every case in this
// file exact rather than merely "true across a wide enough day-count margin to not flake."
const NOW = 1_700_000_000_000;

function env(kv: MockKV) {
  return {
    OPENAI_API_KEY: 'x', REALTIME_MODEL: 'x',
    RP_ID: 'localhost', RP_NAME: 'Halden', EXPECTED_ORIGIN: 'http://localhost:3000',
    KV: kv, NOW,
  };
}

function actRequest(body: unknown): Request {
  return new Request('http://localhost/api/act', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function act(kv: MockKV, body: unknown) {
  const res = await worker.fetch(actRequest(body), env(kv) as any);
  return { status: res.status, body: await res.json() as any };
}

const GATED_TOOL = POLICY_RULES.requiresHumanDirect[0]!; // 'confirm_return' in the current policy
const OTHER_GATED_TOOL = POLICY_RULES.requiresHumanDirect[1]!; // 'cancel_order'

describe('/api/act — no token means no action', () => {
  it('refuses a gated tool with no token at all, and touches no KV record', async () => {
    const kv = new MockKV();
    const { status, body } = await act(kv, { tool: GATED_TOOL, requestId: 'req-1' });
    expect(status).toBe(403);
    expect(body).toEqual({ ok: false, error: 'confirmation_required' });
    expect(kv.puts).toEqual([]);
  });
});

describe('/api/act — the token must actually exist', () => {
  it('refuses a token with no matching record', async () => {
    const kv = new MockKV();
    const { status, body } = await act(kv, { tool: GATED_TOOL, requestId: 'req-1', token: 'never-minted' });
    expect(status).toBe(403);
    expect(body.error).toBe('invalid_token');
  });
});

describe('/api/act — a failed KV read must refuse, never crash', () => {
  it('a token whose KV.get throws is refused with a structured 403, not an unhandled rejection', async () => {
    const kv = new MockKV([], ['3way:tok:tok-unreadable']);
    kv.seedToken('tok-unreadable', { requestId: 'req-1', tool: GATED_TOOL, deviceId: 'dev-1', used: false });
    const { status, body } = await act(kv, { tool: GATED_TOOL, requestId: 'req-1', token: 'tok-unreadable' });
    expect(status).toBe(403);
    expect(body).toEqual({ ok: false, error: 'invalid_token' });
    // Same refusal as a genuinely unknown token — see worker/src/index.ts's comment on
    // this exact fold: a read failure tells an unauthenticated caller nothing about
    // whether the token existed.
  });
});

describe('/api/act — single-use: a used token replays its stored result instead of re-running', () => {
  it('returns the exact previously-computed result and does not perform the action again', async () => {
    const kv = new MockKV();
    const stored = { ok: true, tool: OTHER_GATED_TOOL, requestId: 'req-2', refunded: false };
    kv.seedToken('tok-used', {
      requestId: 'req-2', tool: OTHER_GATED_TOOL, deviceId: 'dev-1',
      used: true, result: stored, resultStatus: 200,
    });
    const { status, body } = await act(kv, { tool: OTHER_GATED_TOOL, requestId: 'req-2', token: 'tok-used' });
    expect(status).toBe(200);
    expect(body).toEqual(stored);
    // No re-run: the only write that could happen (marking used again) never happens,
    // because the record's `used: true` short-circuits before any computation.
    expect(kv.puts).toEqual([]);
  });
});

describe('/api/act — a token cannot be redirected to a different request', () => {
  it("refuses when the token's own record disagrees on requestId", async () => {
    const kv = new MockKV();
    kv.seedToken('tok-a', { requestId: 'req-A', tool: GATED_TOOL, deviceId: 'dev-1', used: false });
    const { status, body } = await act(kv, { tool: GATED_TOOL, requestId: 'req-B', token: 'tok-a' });
    expect(status).toBe(403);
    expect(body.error).toBe('invalid_token');
  });
});

describe('/api/act — a token cannot be redirected to a different action (the confirmation-redirect attack)', () => {
  it("refuses when the token's own record disagrees on tool, even though requestId matches", async () => {
    const kv = new MockKV();
    kv.seedToken('tok-a', { requestId: 'req-1', tool: GATED_TOOL, deviceId: 'dev-1', used: false });
    const { status, body } = await act(kv, { tool: OTHER_GATED_TOOL, requestId: 'req-1', token: 'tok-a' });
    expect(status).toBe(403);
    expect(body.error).toBe('invalid_token');
  });
});

describe('/api/act — the token itself is untrusted input', () => {
  it('a non-string token is treated as absent — confirmation_required, never a 500', async () => {
    const kv = new MockKV();
    const { status, body } = await act(kv, { tool: GATED_TOOL, requestId: 'req-1', token: 12345 });
    expect(status).toBe(403);
    expect(body.error).toBe('confirmation_required');
  });

  it.each([
    ['oversized (>128 chars)', 'x'.repeat(300)],
    ['colon-containing', 'req-1:cancel_order:dev-1'],
  ])('a %s token string is refused with 403 invalid_token, never a 500', async (_label, token) => {
    const kv = new MockKV();
    const { status, body } = await act(kv, { tool: GATED_TOOL, requestId: 'req-1', token });
    expect(status).toBe(403);
    expect(body.error).toBe('invalid_token');
  });
});

describe('/api/act — the tool allowlist runs before the gate', () => {
  it('refuses an unrecognized tool with 404 and never consults KV at all', async () => {
    const kv = new MockKV();
    const { status, body } = await act(kv, { tool: 'delete_everything', requestId: 'req-1', token: 'irrelevant' });
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'not_found' });
    expect(kv.gets).toEqual([]);
    expect(kv.puts).toEqual([]);
  });

  it('an inexact match (wrong case) is treated the same as unrecognized', async () => {
    const kv = new MockKV();
    const { status } = await act(kv, { tool: 'Confirm_Return', requestId: 'req-1' });
    expect(status).toBe(404);
  });
});

describe('/api/act — single-use must not degrade to multi-use when the burn write fails', () => {
  it('a failed mark-used write returns a non-200 error, and the token is still unspent afterward', async () => {
    const kv = new MockKV(['3way:tok:tok-fail']);
    kv.seedToken('tok-fail', {
      requestId: 'req-3', tool: OTHER_GATED_TOOL, deviceId: 'dev-1', used: false,
    });
    const { status, body } = await act(kv, { tool: OTHER_GATED_TOOL, requestId: 'req-3', token: 'tok-fail' });
    expect(status).not.toBe(200);
    expect(body.ok).toBe(false);
    const stillThere = JSON.parse(kv.store.get('3way:tok:tok-fail')!) as StoredTokenRecord;
    expect(stillThere.used).toBe(false);
  });

  it('once the write genuinely succeeds, a replay with the same token returns the identical result', async () => {
    const kv = new MockKV();
    // cancel_order binds its subject at mint time like every other gated action, so a
    // token without one is refused as unknown_order rather than completing generically.
    kv.seedToken('tok-ok', { requestId: 'req-4', tool: OTHER_GATED_TOOL, deviceId: 'dev-1', orderId: 'ORD-1118', used: false });
    const first = await act(kv, { tool: OTHER_GATED_TOOL, requestId: 'req-4', token: 'tok-ok' });
    const second = await act(kv, { tool: OTHER_GATED_TOOL, requestId: 'req-4', token: 'tok-ok' });
    expect(first.body).toEqual(second.body);
    expect(first.body.ok).toBe(true);
  });
});

describe('/api/act — confirm_return eligibility is decided from the token record, never the request body', () => {
  it('an ineligible bound reason is refused with the real verdict', async () => {
    const kv = new MockKV();
    // ORD-1043 was delivered 35 days ago (see config/seed.ts) — past the 30-day window,
    // so a change-of-mind return is denied.
    kv.seedToken('tok-ineligible', {
      requestId: 'req-5', tool: 'confirm_return', deviceId: 'dev-1',
      orderId: 'ORD-1043', itemId: 'IT-1', reason: 'changed-mind', used: false,
    });
    const { status, body } = await act(kv, { tool: 'confirm_return', requestId: 'req-5', token: 'tok-ineligible' });
    expect(status).toBe(403);
    expect(body.error).toBe('ineligible');
    expect(body.eligibility.eligible).toBe(false);
  });

  it('a request body that smuggles a different, favorable reason is ignored — the bound record still governs', async () => {
    const kv = new MockKV();
    kv.seedToken('tok-smuggle', {
      requestId: 'req-6', tool: 'confirm_return', deviceId: 'dev-1',
      orderId: 'ORD-1043', itemId: 'IT-1', reason: 'changed-mind', used: false,
    });
    // /api/act's request type has no orderId/itemId/reason fields at all, but nothing
    // stops raw JSON from carrying extra ones — this proves they're never read.
    const { status, body } = await act(kv, {
      tool: 'confirm_return', requestId: 'req-6', token: 'tok-smuggle',
      orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect',
    });
    expect(status).toBe(403);
    expect(body.error).toBe('ineligible');
  });

  it('an eligible bound reason succeeds and reports the refund', async () => {
    const kv = new MockKV();
    kv.seedToken('tok-eligible', {
      requestId: 'req-7', tool: 'confirm_return', deviceId: 'dev-1',
      orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect', used: false,
    });
    const { status, body } = await act(kv, { tool: 'confirm_return', requestId: 'req-7', token: 'tok-eligible' });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, tool: 'confirm_return', requestId: 'req-7', refunded: true });
  });
});

/**
 * WHAT THIS FILE CANNOT COVER, stated rather than left implicit:
 *
 * 1. The eventual-consistency replay window described in worker/src/index.ts — a `get`
 *    racing a `put` that hasn't yet propagated to Workers KV's other colos. MockKV is a
 *    plain synchronous Map: every `put` is instantly visible to every subsequent `get`,
 *    with no replication lag and no concurrency at all (there is nothing here that can
 *    interleave two in-flight requests). A test passing against this mock says nothing
 *    about that race; it can only be observed against the real service, or reasoned about
 *    directly (which is what the code comment does).
 * 2. Anything requiring a real WebAuthn assertion — /api/webauthn/options and /verify's
 *    register/authenticate branches, the mode-confusion guard, and @simplewebauthn's own
 *    signature verification are exercised here not at all (this file is scoped to
 *    /api/act). Those require a real authenticator or CDP virtual authenticator and are
 *    outside this test file's scope.
 * 3. TTL expiry: MockKV.put ignores the `expirationTtl` option entirely, so a token or
 *    challenge record here never expires. Real Workers KV enforces it. Nothing in this
 *    file would catch a bug in the TTL values themselves.
 * 4. The `safeGet`/`safeDelete` wrapping added alongside this note covers every
 *    `env.KV.get`/`env.KV.delete` call in worker/src/index.ts, but only the one inside
 *    /api/act (the token read, tested above) is exercised by THIS file. The credential
 *    read in /api/webauthn/options, the challenge read+delete and the two credential
 *    reads in /api/webauthn/verify are hardened by the same helpers and fail closed the
 *    same way (a structured 500 `storage_error`, never falling through to a permissive
 *    branch — e.g. a failed already-registered check does not proceed to register), but
 *    are not covered by a throwing-KV test here, for the same reason point 2 gives: those
 *    endpoints have no test coverage in this repo at all yet, real or simulated.
 */

/**
 * The other half of the same fix: binding a subject at mint time is only worth anything
 * if /api/act then acts on THAT subject and re-derives the verdict itself. Both tools
 * previously landed in a generic `{ ok: true, refunded: false }` branch that named
 * nothing at all.
 */
describe('/api/act — cancel_order and change_address act on the subject bound to the ceremony', () => {
  it('cancels the order the token was minted for, and names it', async () => {
    const kv = new MockKV();
    kv.seedToken('tok-c', {
      requestId: 'req-c', tool: 'cancel_order', deviceId: 'dev-1', orderId: 'ORD-1118', used: false });
    const { status, body } = await act(kv, { tool: 'cancel_order', requestId: 'req-c', token: 'tok-c' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.orderId).toBe('ORD-1118');
    expect(body.cancelled).toBe(true);
  });

  it('re-derives eligibility instead of trusting the verdict the page captured when it filed', async () => {
    // ORD-1043 was delivered 35 days ago. A page that filed a cancellation while the
    // order was still in transit cannot spend the token against that stale verdict.
    const kv = new MockKV();
    kv.seedToken('tok-late', {
      requestId: 'req-late', tool: 'cancel_order', deviceId: 'dev-1', orderId: 'ORD-1043', used: false });
    const { status, body } = await act(kv, { tool: 'cancel_order', requestId: 'req-late', token: 'tok-late' });
    expect(status).toBe(403);
    expect(body.error).toBe('ineligible');
  });

  it('completes an address change against the address bound at mint time', async () => {
    const kv = new MockKV();
    kv.seedToken('tok-a', {
      requestId: 'req-a', tool: 'change_address', deviceId: 'dev-1', orderId: 'ORD-1118',
      address: '14 Bellweather Lane, Bristol BS1 4TR', used: false } as any);
    const { status, body } = await act(kv, { tool: 'change_address', requestId: 'req-a', token: 'tok-a' });
    expect(status).toBe(200);
    expect(body.address).toBe('14 Bellweather Lane, Bristol BS1 4TR');
    expect(body.orderId).toBe('ORD-1118');
  });

  it('refuses an address change whose record carries no address rather than redirecting to nowhere', async () => {
    // Unreachable through the mint paths, which refuse without one. Asserted anyway: "the
    // record says nothing" must never resolve to "proceed anyway".
    const kv = new MockKV();
    kv.seedToken('tok-a0', {
      requestId: 'req-a0', tool: 'change_address', deviceId: 'dev-1', orderId: 'ORD-1118', used: false });
    const { status, body } = await act(kv, { tool: 'change_address', requestId: 'req-a0', token: 'tok-a0' });
    expect(status).toBe(400);
    expect(body.error).toBe('missing_eligibility_fields');
  });

  it('refuses a token whose bound order does not exist', async () => {
    const kv = new MockKV();
    kv.seedToken('tok-x', {
      requestId: 'req-x', tool: 'cancel_order', deviceId: 'dev-1', orderId: 'ORD-NOPE', used: false });
    const { status, body } = await act(kv, { tool: 'cancel_order', requestId: 'req-x', token: 'tok-x' });
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_order');
  });
});

describe('/api/act — every policy-gated tool has an explicit executor', () => {
  const SUBJECTS: Record<string, Partial<StoredTokenRecord>> = {
    confirm_return: { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' },
    cancel_order: { orderId: 'ORD-1118' },
    change_address: { orderId: 'ORD-1118', address: '14 Bellweather Lane, Bristol' },
    disclose_order_records: { orderId: 'ORD-1043' },
    release_records: { orderId: 'VIS-2291', itemId: 'Dr. Okafor', scope: 'routine' },
  };
  const ASSERT_EXPLICIT: Record<string, (body: any) => void> = {
    confirm_return: body => expect(body.refunded).toBe(true),
    cancel_order: body => expect(body.cancelled).toBe(true),
    change_address: body => expect(body.address).toBe('14 Bellweather Lane, Bristol'),
    disclose_order_records: body => expect(body.records).toBeDefined(),
    release_records: body => expect(body.released.documents.length).toBeGreaterThan(0),
  };
  const GATED = [...new Set([
    ...POLICY_RULES.requiresHumanDirect,
    ...CLINIC_POLICY_RULES.requiresHumanDirect,
  ])];

  it.each(GATED)('%s executes its own explicit behavior', async (tool) => {
    const subject = SUBJECTS[tool];
    const assertExplicit = ASSERT_EXPLICIT[tool];
    if (!subject || !assertExplicit) throw new Error(`No executor fixture for policy-gated tool ${tool}`);
    const kv = new MockKV();
    const token = `tok-${tool}`;
    kv.seedToken(token, {
      requestId: `req-${tool}`, tool, deviceId: `dev-${tool}`, used: false, ...subject,
    });
    const { status, body } = await act(kv, {
      tool, requestId: `req-${tool}`, token,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    assertExplicit(body);
  });

  it('never releases restricted records, whatever scope the token was bound to', async () => {
    const executeRoutine = async (token: string, requestId: string, scope?: string) => {
      const kv = new MockKV();
      kv.seedToken(token, {
        requestId, tool: 'release_records', deviceId: `dev-${requestId}`, tenant: 'C',
        orderId: 'VIS-2180', itemId: 'Dr. Okafor', used: false, ...(scope !== undefined ? { scope } : {}),
      });
      return act(kv, { tool: 'release_records', requestId, token });
    };
    const omitted = await executeRoutine('tok-scope-omitted', 'req-scope-omitted');
    const empty = await executeRoutine('tok-scope-empty', 'req-scope-empty', '');
    // Even a token bound to include-restricted releases only routine records now — the
    // authoritative gate excludes restricted unconditionally.
    const wide = await executeRoutine('tok-scope-wide', 'req-scope-wide', 'include-restricted');
    expect(omitted.status).toBe(200);
    expect(empty.status).toBe(200);
    expect(wide.status).toBe(200);
    expect(empty.body.released.documents).toEqual(omitted.body.released.documents);
    expect(wide.body.released.documents).toEqual(omitted.body.released.documents);
    for (const r of [omitted, empty, wide]) {
      expect(r.body.released.documents.map((d: any) => d.category)).not.toContain('mental-health');
    }
  });

  it('refuses policy drift when a tool has no executor instead of returning generic success', async () => {
    const drifted = 'future_gated_tool';
    POLICY_RULES.requiresHumanDirect.push(drifted);
    try {
      const kv = new MockKV();
      kv.seedToken('tok-future', {
        requestId: 'req-future', tool: drifted, deviceId: 'dev-future', used: false,
      });
      const { status, body } = await act(kv, {
        tool: drifted, requestId: 'req-future', token: 'tok-future',
      });
      expect(status).toBe(500);
      expect(body).toEqual({ ok: false, error: 'unimplemented_tool' });
    } finally {
      POLICY_RULES.requiresHumanDirect.splice(POLICY_RULES.requiresHumanDirect.indexOf(drifted), 1);
    }
  });

  it('still refuses an unimplemented policy tool when the demo disables hardware confirmation', async () => {
    const drifted = 'future_weak_gated_tool';
    const originalHardwareRule = POLICY_RULES.requireHardwareConfirmation;
    POLICY_RULES.requiresHumanDirect.push(drifted);
    POLICY_RULES.requireHardwareConfirmation = false;
    try {
      const { status, body } = await act(new MockKV(), {
        tool: drifted, requestId: 'req-future-weak',
      });
      expect(status).toBe(500);
      expect(body).toEqual({ ok: false, error: 'unimplemented_tool' });
    } finally {
      POLICY_RULES.requireHardwareConfirmation = originalHardwareRule;
      POLICY_RULES.requiresHumanDirect.splice(POLICY_RULES.requiresHumanDirect.indexOf(drifted), 1);
    }
  });

  it('uses the cancellation executor even when only the demo authorization layer is weak', async () => {
    const originalHardwareRule = POLICY_RULES.requireHardwareConfirmation;
    POLICY_RULES.requireHardwareConfirmation = false;
    try {
      const { status, body } = await act(new MockKV(), {
        tool: 'cancel_order', requestId: 'req-weak-cancel', orderId: 'ORD-1118',
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({
        ok: true, tool: 'cancel_order', requestId: 'req-weak-cancel',
        orderId: 'ORD-1118', cancelled: true,
      });
    } finally {
      POLICY_RULES.requireHardwareConfirmation = originalHardwareRule;
    }
  });
});
