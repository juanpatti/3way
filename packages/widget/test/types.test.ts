import { describe, it, expect } from 'vitest';
import { ORIGINS, isAgentOrigin } from '../src/types';

describe('origins', () => {
  it('enumerates exactly four speakers', () => {
    expect(ORIGINS).toEqual(['human-direct', 'agent-relay', 'agent-autonomous', 'site-agent']);
  });

  it('classifies visiting-agent origins', () => {
    expect(isAgentOrigin('agent-relay')).toBe(true);
    expect(isAgentOrigin('agent-autonomous')).toBe(true);
    expect(isAgentOrigin('human-direct')).toBe(false);
    expect(isAgentOrigin('site-agent')).toBe(false);
  });
});
