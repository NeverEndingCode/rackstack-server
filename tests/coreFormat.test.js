import { describe, it, expect } from 'vitest';
import {
  CORE_FORMATS,
  CORE_FORMAT_LABELS,
  DEFAULT_CORE_FORMAT,
  normalizeCoreFormat,
  nextCoreFormat,
  fmtCores,
} from '../shared/gameRules.js';

describe('core number formats', () => {
  it('exposes exactly the three offered formats, with a label for each', () => {
    expect(CORE_FORMATS).toEqual(['full', 'letters', 'scientific']);
    expect(DEFAULT_CORE_FORMAT).toBe('full');
    for (const f of CORE_FORMATS) expect(typeof CORE_FORMAT_LABELS[f]).toBe('string');
  });

  it('normalizes anything unrecognized back to the default', () => {
    expect(normalizeCoreFormat('letters')).toBe('letters');
    expect(normalizeCoreFormat('scientific')).toBe('scientific');
    expect(normalizeCoreFormat('nonsense')).toBe(DEFAULT_CORE_FORMAT);
    expect(normalizeCoreFormat(null)).toBe(DEFAULT_CORE_FORMAT);
    expect(normalizeCoreFormat(undefined)).toBe(DEFAULT_CORE_FORMAT);
  });

  it('cycles through the formats and wraps around', () => {
    expect(nextCoreFormat('full')).toBe('letters');
    expect(nextCoreFormat('letters')).toBe('scientific');
    expect(nextCoreFormat('scientific')).toBe('full');
    expect(nextCoreFormat('nonsense')).toBe('letters'); // treated as the default
  });

  describe('full', () => {
    it('keeps the pre-existing plain-integer rendering', () => {
      expect(fmtCores(0, 'full')).toBe('0');
      expect(fmtCores(42, 'full')).toBe('42');
      expect(fmtCores(4087353084334554000, 'full')).toBe('4087353084334554000');
    });
    it('is what an unknown or missing format falls back to', () => {
      expect(fmtCores(1234, 'nonsense')).toBe('1234');
      expect(fmtCores(1234)).toBe('1234');
    });
  });

  describe('letters', () => {
    it('leaves values under a thousand as plain integers', () => {
      expect(fmtCores(0, 'letters')).toBe('0');
      expect(fmtCores(50, 'letters')).toBe('50');
      expect(fmtCores(999, 'letters')).toBe('999');
    });
    it('walks A, B, C... one letter per power of a thousand', () => {
      expect(fmtCores(1e3, 'letters')).toBe('1.00A');
      expect(fmtCores(1e6, 'letters')).toBe('1.00B');
      expect(fmtCores(1e9, 'letters')).toBe('1.00C');
      expect(fmtCores(1e12, 'letters')).toBe('1.00D');
      expect(fmtCores(1e15, 'letters')).toBe('1.00E');
      expect(fmtCores(1e18, 'letters')).toBe('1.00F');
      expect(fmtCores(1e21, 'letters')).toBe('1.00G');
    });
    it('keeps three significant figures like fmt() does', () => {
      expect(fmtCores(4087353084334554000, 'letters')).toBe('4.09F');
      expect(fmtCores(12_345, 'letters')).toBe('12.3A');
      expect(fmtCores(123_456, 'letters')).toBe('123A');
    });
    it('continues past Z into AA, AB, ... rather than falling apart', () => {
      expect(fmtCores(1e78, 'letters')).toBe('1.00Z');
      expect(fmtCores(1e81, 'letters')).toBe('1.00AA');
      expect(fmtCores(1e84, 'letters')).toBe('1.00AB');
    });
    it('handles negatives and infinities', () => {
      expect(fmtCores(-1e6, 'letters')).toBe('-1.00B');
      expect(fmtCores(Infinity, 'letters')).toBe('∞');
      expect(fmtCores(NaN, 'letters')).toBe('∞');
    });
  });

  describe('scientific', () => {
    it('leaves values under a thousand as plain integers', () => {
      expect(fmtCores(0, 'scientific')).toBe('0');
      expect(fmtCores(50, 'scientific')).toBe('50');
      expect(fmtCores(999, 'scientific')).toBe('999');
    });
    it('uses the same e+NN shape the balance readout already uses', () => {
      expect(fmtCores(1e3, 'scientific')).toBe('1.00e+3');
      expect(fmtCores(4087353084334554000, 'scientific')).toBe('4.09e+18');
      expect(fmtCores(124626540980725780, 'scientific')).toBe('1.25e+17');
    });
    it('handles negatives and infinities', () => {
      expect(fmtCores(-1e6, 'scientific')).toBe('-1.00e+6');
      expect(fmtCores(Infinity, 'scientific')).toBe('∞');
    });
  });
});
