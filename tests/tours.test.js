import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { TOURS, TOUR_IDS, isValidTourId, ONBOARDING_TOUR_ID } from '../shared/tours.js';

describe('shared/tours registry', () => {
  it('registers the onboarding tour', () => {
    expect(ONBOARDING_TOUR_ID).toBe('onboarding');
    expect(TOUR_IDS).toContain('onboarding');
  });

  it('has unique ids and complete metadata', () => {
    expect(new Set(TOUR_IDS).size).toBe(TOUR_IDS.length);
    for (const t of TOURS) {
      expect(typeof t.id).toBe('string');
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.autoStart).toBe('boolean');
    }
  });

  it('validates ids', () => {
    expect(isValidTourId('onboarding')).toBe(true);
    expect(isValidTourId('nope')).toBe(false);
    expect(isValidTourId('')).toBe(false);
    expect(isValidTourId(null)).toBe(false);
    expect(isValidTourId(123)).toBe(false);
    // must not be fooled by Object.prototype members
    expect(isValidTourId('toString')).toBe(false);
    expect(isValidTourId('__proto__')).toBe(false);
  });
});
