import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, TUNABLES, validateConfig, upgradeConfig, getAtPath } from '../shared/configSchema.js';

describe('configSchema', () => {
  it('has the spec §3.6 defaults', () => {
    expect(DEFAULT_CONFIG.schemaVersion).toBe(1);
    expect(DEFAULT_CONFIG.heat.capacity).toBe(2000);
    expect(DEFAULT_CONFIG.heat.ventPercent).toBe(25);
    expect(DEFAULT_CONFIG.heat.overheatPopupMs).toBe(15000);
    expect(DEFAULT_CONFIG.heat.ventAmount).toBeUndefined();
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

describe('social config section', () => {
  it('every social leaf has a matching TUNABLES entry', () => {
    const paths = new Set(TUNABLES.map((t) => t.path));
    for (const key of Object.keys(DEFAULT_CONFIG.social)) {
      expect(paths.has(`social.${key}`), `social.${key}`).toBe(true);
    }
  });
  it('DEFAULT_CONFIG still validates with the new section', () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual({ ok: true });
  });
  it('every social default sits inside its declared range', () => {
    for (const t of TUNABLES.filter((row) => row.path.startsWith('social.'))) {
      const v = DEFAULT_CONFIG.social[t.path.slice('social.'.length)];
      expect(v, t.path).toBeGreaterThanOrEqual(t.min);
      expect(v, t.path).toBeLessThanOrEqual(t.max);
      if (t.integer) expect(Number.isInteger(v), t.path).toBe(true);
    }
  });
});

describe('v1.6 heat tunables', () => {
  it('exposes ventPercent and overheatPopupMs with the documented bounds', () => {
    const pct = TUNABLES.find((t) => t.path === 'heat.ventPercent');
    expect(pct).toMatchObject({ min: 1, max: 100 });
    expect(pct.integer).toBeFalsy();

    const popup = TUNABLES.find((t) => t.path === 'heat.overheatPopupMs');
    expect(popup).toMatchObject({ min: 0, max: 600000, integer: true });
  });

  it('no longer exposes ventAmount as a tunable', () => {
    expect(TUNABLES.find((t) => t.path === 'heat.ventAmount')).toBeUndefined();
  });

  // upgradeConfig rebuilds from DEFAULT_CONFIG and copies only TUNABLES
  // paths, so a pre-v1.6 stored document migrates with no migration code.
  it('drops a stored ventAmount and adopts the ventPercent default', () => {
    const legacy = { heat: { capacity: 4000, ventAmount: 900, ventCooldownMs: 3000 } };
    const out = upgradeConfig(legacy);
    expect(out.heat.ventAmount).toBeUndefined();
    expect(out.heat.ventPercent).toBe(25);
    expect(out.heat.overheatPopupMs).toBe(15000);
    expect(out.heat.capacity).toBe(4000);      // tuned values still carry over
    expect(out.heat.ventCooldownMs).toBe(3000);
  });
});
