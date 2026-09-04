import type { ConfirmationProof, LogEntry, Origin } from './types';

export interface BusOpts { now: () => number; id: () => string }

/** Either recognized assurance level counts here — see hasAssuredConfirmation's own doc. */
const isRecognizedProof = (v: ConfirmationProof | undefined): v is ConfirmationProof =>
  v?.method === 'webauthn' || v?.method === 'trusted-click';

export interface Bus {
  append(e: {
    origin: Origin; text: string; confirms?: string; confirmsTool?: string;
    context?: Record<string, unknown>; verification?: ConfirmationProof;
    authoredByTool?: boolean;
  }): LogEntry;
  all(): readonly LogEntry[];
  since(cursor: string | null): { entries: LogEntry[]; cursor: string | null };
  subscribe(fn: (e: LogEntry) => void): () => void;
  /** Origin check only. Forgeable by a computer-use agent — never gate on this alone. */
  hasHumanConfirmation(requestId: string): boolean;
  /**
   * Origin check plus a server-issued, cryptographically verified WebAuthn token.
   * STRICTLY 'webauthn' — a trusted-click proof does not satisfy this, on purpose, for
   * any caller (e.g. a "verified" badge) that must not blur the two assurance levels.
   * ADVISORY ONLY — it proves a token was carried, not that it is valid. The Worker
   * re-checks the token before acting. Pass `tool` to also require the confirmation was
   * stamped for that specific action — a confirmation for confirm_return must not unlock
   * cancel_order. Omit it to check origin and proof only, unchanged from before this
   * parameter existed.
   */
  hasVerifiedConfirmation(requestId: string, tool?: string): boolean;
  /**
   * Origin check plus ANY recorded confirmation proof — 'webauthn' OR 'trusted-click'.
   * This is what checkGate's hardware-required branch actually asks: "was a recognized
   * assurance level recorded," not "which one." WHICH level was appropriate was already
   * decided upstream, before this entry was ever appended (session.ts's confirmRequest /
   * verify.ts's verifyHumanPresence, gated on isAuthenticatorAvailable() and
   * PolicyRules.onMissingAuthenticator) — never re-decided here. Same `tool` binding as
   * hasVerifiedConfirmation.
   */
  hasAssuredConfirmation(requestId: string, tool?: string): boolean;
  /** The token to present to /api/act, or null if none is on the log. Same `tool` binding as above. */
  confirmationToken(requestId: string, tool?: string): string | null;
}

export function createBus(opts: BusOpts): Bus {
  const log: LogEntry[] = [];
  const subs = new Set<(e: LogEntry) => void>();

  return {
    append(e) {
      const entry: LogEntry = { ...e, id: opts.id(), at: opts.now() };
      log.push(entry);
      for (const fn of subs) {
        // A throwing subscriber must not block delivery to the others or escape append.
        try { fn(entry); } catch (err) { console.error('bus subscriber threw', err); }
      }
      return entry;
    },
    all: () => log.slice(),
    since(cursor) {
      const i = cursor === null ? -1 : log.findIndex(e => e.id === cursor);
      // Unknown cursor: treat as a fresh reader rather than throwing across a tool boundary.
      const entries = log.slice(i + 1);
      return { entries, cursor: log.at(-1)?.id ?? null };
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    hasHumanConfirmation: (requestId) =>
      log.some(e => e.origin === 'human-direct' && e.confirms === requestId),
    // `tool` binding: session.confirmRequest stamps confirmsTool on the entry it
    // appends, so a confirmation minted for one action cannot be replayed to authorize another.
    hasVerifiedConfirmation: (requestId, tool) =>
      log.some(e => e.origin === 'human-direct' && e.confirms === requestId
        && e.verification?.method === 'webauthn'
        && (tool === undefined || e.confirmsTool === tool)),
    hasAssuredConfirmation: (requestId, tool) =>
      log.some(e => e.origin === 'human-direct' && e.confirms === requestId
        && isRecognizedProof(e.verification)
        && (tool === undefined || e.confirmsTool === tool)),
    confirmationToken: (requestId, tool) =>
      log.find(e => e.origin === 'human-direct' && e.confirms === requestId
        && isRecognizedProof(e.verification)
        && (tool === undefined || e.confirmsTool === tool))?.verification?.token ?? null,
  };
}
