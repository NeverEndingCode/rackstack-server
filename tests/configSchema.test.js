import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, TUNABLES, validateConfig, upgradeConfig, getAtPath } from '../shared/configSchema.js';

describe('configSchema', () => {
  it('has the spec §3.6 defaults', () => {
    expect(DEFAULT_CONFIG.schemaVersion).toBe(1);
    expect(DEFAULT_CONFIG.heat.capacity).toBe(2000);
    // v1.12 retuned the vent curve: 35% of capacity per 15s, was 25% per 2.5s.
    expect(DEFAULT_CONFIG.heat.ventPercent).toBe(35);
    expect(DEFAULT_CONFIG.heat.overheatPopupMs).toBe(15000);
    expect(DEFAULT_CONFIG.heat.ventAmount).toBeUndefined();
    expect(DEFAULT_CONFIG.heat.ventCooldownMs).toBe(15000);
    expect(DEFAULT_CONFIG.heat.overheatCooldownMs).toBe(10000);
    expect(DEFAULT_CONFIG.minigames.balance).toMatchObject({
      pointsSafe: 1, pointsRisk: 5, missPenalty: 2, riskZoneWidth: 4,
      safeZoneMin: 35, safeZoneMax: 65, durationSec: 12,
    });
    expect(DEFAULT_CONFIG.production).toMatchObject({ globalMult: 1, racksMult: 1, gridMult: 1, overclockMult: 1 });
    expect(DEFAULT_CONFIG.offline.onlineGapThresholdSec).toBe(60);
    expect(DEFAULT_CONFIG.offline.hardCapHours).toBe(72);
    expect(DEFAULT_CONFIG.upgrades.maxLevels.firmware).toBe(20);
    expect(DEFAULT_CONFIG.anomaly).toMatchObject({ windowMs: 30000, minDelayMs: 420000, maxDelayMs: 900000 });
  });
  it('every TUNABLES path resolves in DEFAULT_CONFIG and is in range', () => {
    for (const t of TUNABLES) {
      const v = getAtPath(DEFAULT_CONFIG, t.path);
      // v1.11: boolean tunables carry no min/max - the type IS the range.
      if (t.type === 'boolean') {
        expect(v, t.path).toBeTypeOf('boolean');
        continue;
      }
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
    expect(out.heat.ventPercent).toBe(35);
    expect(out.heat.overheatPopupMs).toBe(15000);
    expect(out.heat.capacity).toBe(4000);      // tuned values still carry over
    expect(out.heat.ventCooldownMs).toBe(3000);
  });
});

describe('boolean tunables (v1.11)', () => {
  it('validates booleans on boolean paths and rejects numbers there', () => {
    expect(validateConfig(DEFAULT_CONFIG).ok).toBe(true);

    const bad = structuredClone(DEFAULT_CONFIG);
    bad.risk.enabled = 1;
    const res = validateConfig(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith('risk.enabled:'))).toBe(true);
  });

  it('rejects a boolean on a numeric path', () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.heat.capacity = true;
    expect(validateConfig(bad).ok).toBe(false);
  });

  it('upgradeConfig copies booleans through and fills missing ones', () => {
    const old = { schemaVersion: 1, risk: { enabled: false } };
    const up = upgradeConfig(old);
    expect(up.risk.enabled).toBe(false);          // preserved
    expect(up.risk.hazardsEnabled).toBe(true);    // filled from defaults
    expect(validateConfig(up).ok).toBe(true);
  });

  it('has the v1.11 risk defaults and every risk leaf is a TUNABLES row', () => {
    expect(DEFAULT_CONFIG.risk.enabled).toBe(true);
    expect(DEFAULT_CONFIG.risk.ransomwareFactor).toBe(0.35);   // v1.12: softer but twice as frequent
    expect(DEFAULT_CONFIG.risk.overclockBoostGain).toBe(1);
    const paths = new Set(TUNABLES.map((t) => t.path));
    for (const key of Object.keys(DEFAULT_CONFIG.risk)) {
      expect(paths.has(`risk.${key}`), `risk.${key}`).toBe(true);
    }
  });
});

describe('v1.12 config surface', () => {
  it('DEFAULT_CONFIG still validates with the new leaves', () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual({ ok: true });
  });

  it('every new v1.12 path exists and has a TUNABLES row', () => {
    const paths = [
      'heat.autoVentPerLevel', 'heat.thermalPerLevel', 'heat.heatsinkPerLevel', 'heat.discountFloor',
      'anomaly.creditsSecondsMin', 'anomaly.creditsSecondsMax',
      'anomaly.boostDurationMinMs', 'anomaly.boostDurationMaxMs',
      'anomaly.boostMultMin', 'anomaly.boostMultMax',
      'production.levelBonusPerLevel', 'production.levelBonusMaxLevel',
      'prestige.migrateDivisor', 'prestige.migrateExponent', 'prestige.corePercentPerCore',
      'prestige.coreBonusCap', 'prestige.echoPercentPerLevel', 'prestige.shardsPerCore',
      'minigames.balance.waferPerPoint',
      'risk.driveFailureTargetsTopTier', 'risk.overheatTargetsTopTier',
    ];
    const rows = new Set(TUNABLES.map((t) => t.path));
    for (const p of paths) {
      expect(getAtPath(DEFAULT_CONFIG, p), `missing DEFAULT_CONFIG leaf ${p}`).toBeDefined();
      expect(rows.has(p), `missing TUNABLES row ${p}`).toBe(true);
    }
  });

  it('the two new risk switches are boolean-typed tunables', () => {
    for (const p of ['risk.driveFailureTargetsTopTier', 'risk.overheatTargetsTopTier']) {
      expect(TUNABLES.find((t) => t.path === p).type).toBe('boolean');
    }
  });

  it('upgradeConfig folds the new paths into a stored pre-v1.12 config', () => {
    // a stored config written before v1.12 simply lacks these leaves
    const old = structuredClone(DEFAULT_CONFIG);
    delete old.prestige;
    delete old.production.levelBonusPerLevel;
    const upgraded = upgradeConfig(old);
    expect(upgraded.prestige.coreBonusCap).toBe(400);
    expect(upgraded.production.levelBonusPerLevel).toBe(0.02);
    expect(validateConfig(upgraded)).toEqual({ ok: true });
  });

  it('carries the recalibrated v1.12 values', () => {
    expect(DEFAULT_CONFIG.anomaly.minDelayMs).toBe(420000);
    expect(DEFAULT_CONFIG.heat.ventCooldownMs).toBe(15000);
    expect(DEFAULT_CONFIG.risk.hazardMinDelayMs).toBe(7200000);
    expect(DEFAULT_CONFIG.minigames.winCooldownMs).toBe(300000);
    expect(DEFAULT_CONFIG.upgrades.maxLevels.engine).toBe(12);
  });
});
