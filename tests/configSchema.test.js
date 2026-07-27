import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, TUNABLES, validateConfig, upgradeConfig, getAtPath } from '../shared/configSchema.js';

describe('configSchema', () => {
  it('has the spec §3.6 defaults', () => {
    expect(DEFAULT_CONFIG.schemaVersion).toBe(1);
    expect(DEFAULT_CONFIG.heat.capacity).toBe(2000);
    expect(DEFAULT_CONFIG.heat.ventAmount).toBe(500);
    expect(DEFAULT_CONFIG.heat.ventCooldownMs).toBe(2500);
    expect(DEFAULT_CONFIG.heat.overheatCooldownMs).toBe(10000);
    expect(DEFAULT_CONFIG.minigames.balance).toMatchObject({
      pointsSafe: 1, pointsRisk: 5, missPenalty: 2, riskZoneWidth: 4,
      safeZoneMin: 35, safeZoneMax: 65, durationSec: 12,
    });
    expect(DEFAULT_CONFIG.production).toEqual({ globalMult: 1, racksMult: 1, gridMult: 1, overclockMult: 1 });
    expect(DEFAULT_CONFIG.offline.onlineGapThresholdSec).toBe(60);
    expect(DEFAULT_CONFIG.offline.hardCapHours).toBe(72);
    expect(DEFAULT_CONFIG.upgrades.maxLevels.firmware).toBe(20);
    expect(DEFAULT_CONFIG.anomaly).toEqual({ windowMs: 15000, minDelayMs: 70000, maxDelayMs: 150000 });
  });
  it('every TUNABLES path resolves in DEFAULT_CONFIG and is in range', () => {
    for (const t of TUNABLES) {
      const v = getAtPath(DEFAULT_CONFIG, t.path);
      expect(v, t.path).toBeTypeOf('number');
      expect(v).toBeGreaterThanOrEqual(t.min);
      expect(v).toBeLessThanOrEqual(t.max);
    }
  });
  it('validateConfig accepts defaults, rejects out-of-range and junk', () => {
    expect(validateConfig(DEFAULT_CONFIG).ok).toBe(true);
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.heat.capacity = -5;
    expect(validateConfig(bad).ok).toBe(false);
    const junk = structuredClone(DEFAULT_CONFIG);
    junk.heat.hacked = 1;
    expect(validateConfig(junk).ok).toBe(false);
  });
  it('upgradeConfig fills missing paths from defaults', () => {
    const old = { schemaVersion: 0, heat: { capacity: 3000 } };
    const up = upgradeConfig(old);
    expect(up.schemaVersion).toBe(1);
    expect(up.heat.capacity).toBe(3000);            // preserved
    expect(up.minigames.balance.pointsRisk).toBe(5); // filled
  });
  it('has the v1.3 batchQueue defaults and every leaf is a TUNABLES row', () => {
    expect(DEFAULT_CONFIG.batchQueue.blockDurationMs).toBe(21600000);
    expect(DEFAULT_CONFIG.batchQueue.jobDurationDeepMs).toBe(86400000);
    expect(DEFAULT_CONFIG.upgrades.maxLevels.coldfusion).toBe(15);
    const v = validateConfig(DEFAULT_CONFIG);
    expect(v.ok).toBe(true);
  });
});
