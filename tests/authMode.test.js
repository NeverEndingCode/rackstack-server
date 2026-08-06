import { describe, it, expect } from 'vitest';
import {
  AUTH_MODES, DEFAULT_AUTH_MODE, resolveAuthMode,
  isSuperTokensEnabled, isPassportEnabled,
} from '../server/authMode.js';

describe('resolveAuthMode', () => {
  it('defaults to passport when AUTH_MODE is unset', () => {
    expect(resolveAuthMode({})).toBe('passport');
  });

  it('defaults to passport for an empty or whitespace value', () => {
    // Blanking the field in the Unraid UI is the documented rollback, so it
    // has to land on the legacy stack rather than throw.
    expect(resolveAuthMode({ AUTH_MODE: '' })).toBe('passport');
    expect(resolveAuthMode({ AUTH_MODE: '   ' })).toBe('passport');
  });

  it('accepts each of the three valid modes', () => {
    expect(resolveAuthMode({ AUTH_MODE: 'passport' })).toBe('passport');
    expect(resolveAuthMode({ AUTH_MODE: 'dual' })).toBe('dual');
    expect(resolveAuthMode({ AUTH_MODE: 'supertokens' })).toBe('supertokens');
  });

  it('tolerates surrounding whitespace', () => {
    expect(resolveAuthMode({ AUTH_MODE: '  dual  ' })).toBe('dual');
  });

  it('throws on an unrecognised value rather than falling back', () => {
    // The point of throwing: a typo that silently served the legacy stack
    // would look exactly like a completed rollout until something went wrong
    // weeks later.
    expect(() => resolveAuthMode({ AUTH_MODE: 'supertoken' })).toThrow(/Invalid AUTH_MODE 'supertoken'/);
    expect(() => resolveAuthMode({ AUTH_MODE: 'none' })).toThrow(/Invalid AUTH_MODE/);
  });

  it('names the valid values in the error, so the fix is in the message', () => {
    expect(() => resolveAuthMode({ AUTH_MODE: 'nope' }))
      .toThrow(/passport, dual, supertokens/);
  });

  it('rejects wrong casing but says what was meant', () => {
    expect(() => resolveAuthMode({ AUTH_MODE: 'Passport' }))
      .toThrow(/Did you mean 'passport'\?/);
    expect(() => resolveAuthMode({ AUTH_MODE: 'SUPERTOKENS' }))
      .toThrow(/case-sensitive/);
  });

  it('reads process.env when called with no argument', () => {
    const saved = process.env.AUTH_MODE;
    try {
      process.env.AUTH_MODE = 'dual';
      expect(resolveAuthMode()).toBe('dual');
    } finally {
      if (saved === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = saved;
    }
  });
});

describe('mode predicates', () => {
  it('enables SuperTokens for dual and supertokens only', () => {
    expect(isSuperTokensEnabled('passport')).toBe(false);
    expect(isSuperTokensEnabled('dual')).toBe(true);
    expect(isSuperTokensEnabled('supertokens')).toBe(true);
  });

  it('enables passport routes for passport and dual only', () => {
    expect(isPassportEnabled('passport')).toBe(true);
    expect(isPassportEnabled('dual')).toBe(true);
    expect(isPassportEnabled('supertokens')).toBe(false);
  });

  it('leaves no mode with both stacks disabled', () => {
    // A mode that authenticated nobody would lock every player out, so this
    // is a property of the set, not of any one value.
    for (const mode of AUTH_MODES) {
      expect(isSuperTokensEnabled(mode) || isPassportEnabled(mode)).toBe(true);
    }
  });

  it('has exactly one mode where each stack runs alone, and one where both do', () => {
    const both = AUTH_MODES.filter((m) => isSuperTokensEnabled(m) && isPassportEnabled(m));
    const stOnly = AUTH_MODES.filter((m) => isSuperTokensEnabled(m) && !isPassportEnabled(m));
    const passportOnly = AUTH_MODES.filter((m) => !isSuperTokensEnabled(m) && isPassportEnabled(m));
    expect(both).toEqual(['dual']);
    expect(stOnly).toEqual(['supertokens']);
    expect(passportOnly).toEqual(['passport']);
  });
});

describe('the default is load-bearing', () => {
  it('is passport, so upgrading to v1.8 changes nobody\'s login', () => {
    expect(DEFAULT_AUTH_MODE).toBe('passport');
    expect(resolveAuthMode({})).toBe(DEFAULT_AUTH_MODE);
  });

  it('does not initialise SuperTokens in the default mode', () => {
    expect(isSuperTokensEnabled(resolveAuthMode({}))).toBe(false);
  });

  it('exposes AUTH_MODES frozen, so a caller cannot widen the valid set', () => {
    expect(Object.isFrozen(AUTH_MODES)).toBe(true);
  });
});
