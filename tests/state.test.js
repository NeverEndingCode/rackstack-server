import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { initialState, migrateSave, evaluate } from '../shared/state.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/v11-save.json', import.meta.url)));

describe('migrateSave', () => {
  it('lifts a v1.1 save losslessly into canonical shape', () => {
    const s = migrateSave(fixture);
    expect(s.run.credits).toBe(123);
    expect(s.run.tiers).toHaveLength(14);           // padded
    expect(s.run.tiers[0].owned).toBe(5);
    expect(s.run.heatCooldownUntil).toBeNull();
    expect(s.meta.wafers).toBe(7);
    expect(s.meta.stats.lifetimeFlopsAllTime).toBe(0); // new counter starts at 0
    expect(s.server.gameCooldowns.rush).toBe(0);
  });
  it('is idempotent', () => {
    const once = migrateSave(fixture);
    expect(migrateSave(once)).toEqual(once);
  });
  it('defaults the v1.4 fields on a pre-v1.4 save', () => {
    const preV14 = { run: { credits: 5 }, meta: { wafers: 3, coldStorage: { tapes: 99 } } };
    const s = migrateSave(preV14);
    expect(s.meta.stats.tapesEarnedLifetime).toBe(0);
    expect(s.meta.eventProgress).toBeNull();
    expect(s.meta.coldStorage.tapes).toBe(99); // existing data preserved
  });
  it('preserves in-flight event progress', () => {
    const s = initialState();
    s.meta.eventProgress = { eventId: 'summer', joinedAt: 1, endsAt: 2, baseline: { flopsEarned: 5 }, rungsClaimed: [0, 1] };
    expect(migrateSave(s).meta.eventProgress).toEqual(s.meta.eventProgress);
  });
});

describe('evaluate', () => {
  it('online gap: full production, heat advances', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 10, manager: true, ready: 0 };
    const t0 = 1_000_000;
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, t0, t0 + 30_000); // 30s online
    // 10 pis, manager, base mult 1: 10 * 0.5 F/s * 30s = 150
    expect(s2.run.credits).toBeCloseTo(10 + 150);
    expect(s2.meta.stats.lifetimeFlopsAllTime).toBeCloseTo(150);
  });
  it('offline gap: capped at offlineCapHours, unmanaged accrues to ready', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 10, manager: false, ready: 0 };
    const t0 = 1_000_000;
    const tenHours = 10 * 3600 * 1000;
    const { state: s2, gained } = evaluate(s, DEFAULT_CONFIG, t0, t0 + tenHours);
    const cappedSec = 4 * 3600;                      // base cap, no uptime upgrade
    expect(s2.run.tiers[0].ready).toBeCloseTo(10 * 0.5 * cappedSec);
    expect(gained).toBeCloseTo(10 * 0.5 * cappedSec);
    expect(s2.run.credits).toBe(10);                 // nothing auto-collected
  });
  it('overheat during online gap triggers cooldown, never destroys nodes', () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.heat.capacity = 100;
    const s = initialState();
    s.run.overclock[4] = { id: 4, owned: 400 };       // 400 * 0.55 = 220 heat/s
    const t0 = 1_000_000;
    const { state: s2 } = evaluate(s, cfg, t0, t0 + 10_000);
    expect(s2.run.heat).toBe(0);
    expect(s2.run.heatCooldownUntil).toBe(t0 + 10_000 + cfg.heat.overheatCooldownMs);
    expect(s2.run.overclock[4].owned).toBe(400);
  });
  it('overheated flag is set on the overheating evaluate and cleared on the next one', () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.heat.capacity = 100;
    const s = initialState();
    s.run.overclock[4] = { id: 4, owned: 400 };       // 400 * 0.55 = 220 heat/s
    const t0 = 1_000_000;
    const { state: s2 } = evaluate(s, cfg, t0, t0 + 10_000);
    expect(s2.server.overheated).toBe(true);
    // Next evaluate, short online gap, no new overheat crossing this time.
    const t1 = t0 + 10_000;
    const { state: s3 } = evaluate(s2, cfg, t1, t1 + 5_000);
    expect(s3.server.overheated).toBeFalsy();
  });
});

describe('coldStorage state wiring', () => {
  it('initialState includes coldStorage with a track already running', () => {
    const s = initialState();
    expect(s.meta.coldStorage.blocksClaimed).toHaveLength(16);
    expect(s.meta.coldStorage.blocksClaimed.every((b) => b === false)).toBe(true);
    expect(s.meta.coldStorage.job).toBeNull();
    expect(s.meta.stats.blocksClaimedLifetime).toBe(0);
  });

  it('initialState has a zeroed lifetime tapes counter and no event progress', () => {
    const s = initialState();
    expect(s.meta.stats.tapesEarnedLifetime).toBe(0);
    expect(s.meta.eventProgress).toBeNull();
  });

  it('migrateSave pads a pre-v1.3 save with a fresh coldStorage block', () => {
    const preV13 = { run: { credits: 5 }, meta: { wafers: 3 } }; // no coldStorage key at all
    const s = migrateSave(preV13);
    expect(s.meta.coldStorage.blocksClaimed).toHaveLength(16);
    expect(s.meta.coldStorage.tapes).toBe(0);
    expect(s.meta.coldStorage.job).toBeNull();
  });

  it('migrateSave is idempotent on a save that already has coldStorage progress', () => {
    const s = initialState();
    s.meta.coldStorage.tapes = 42;
    s.meta.coldStorage.blocksClaimed[0] = true;
    s.meta.coldStorage.job = { type: 'index', accruedOfflineSec: 100, startedAt: 1000 };
    const migrated = migrateSave(s);
    expect(migrated.meta.coldStorage.tapes).toBe(42);
    expect(migrated.meta.coldStorage.blocksClaimed[0]).toBe(true);
    expect(migrated.meta.coldStorage.job).toEqual({ type: 'index', accruedOfflineSec: 100, startedAt: 1000 });
  });

  it('heatsinktapes tape upgrade raises the effective overheat threshold', () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.heat.capacity = 100;
    const s = initialState();
    s.meta.coldStorage.upgrades.heatsinktapes = 5; // +500 capacity -> effective 600
    s.run.overclock[4] = { id: 4, owned: 400 }; // 220 heat/s, would overheat a bare cap of 100 in <1s
    const t0 = 1_000_000;
    const { state: s2 } = evaluate(s, cfg, t0, t0 + 2000);
    expect(s2.run.heat).toBeGreaterThan(0); // did NOT overheat, thanks to the heatsinktapes bonus
    expect(s2.run.heatCooldownUntil).toBeNull();
  });

  it('offline job accrues only during an offline gap, using raw elapsed seconds', () => {
    const s = initialState();
    s.meta.coldStorage.job = { type: 'defrag', accruedOfflineSec: 0, startedAt: 1_000_000 }; // 1h = 3600s
    const t0 = 1_000_000;
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, t0, t0 + 30 * 60 * 1000); // 30 min offline gap
    expect(s2.meta.coldStorage.job.accruedOfflineSec).toBeCloseTo(1800, 0);
    const { state: s3 } = evaluate(s2, DEFAULT_CONFIG, t0 + 30 * 60 * 1000, t0 + 30 * 60 * 1000 + 30_000); // 30s ONLINE gap
    expect(s3.meta.coldStorage.job.accruedOfflineSec).toBeCloseTo(1800, 0); // unchanged - online time doesn't count
  });

  it('offline job accrual is capped at the job duration, never overruns', () => {
    const s = initialState();
    s.meta.coldStorage.job = { type: 'defrag', accruedOfflineSec: 0, startedAt: 1_000_000 };
    const t0 = 1_000_000;
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, t0, t0 + 10 * 3600 * 1000); // 10h offline, job is only 1h
    expect(s2.meta.coldStorage.job.accruedOfflineSec).toBe(3600);
  });

  it('evaluate() does not throw on a state missing meta.coldStorage entirely (defensive - production always goes through migrateSave first, but evaluate() is exported and previously tolerated any {run, meta, server} shape)', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 10, manager: false, ready: 0 };
    delete s.meta.coldStorage;
    const t0 = 1_000_000;
    expect(() => evaluate(s, DEFAULT_CONFIG, t0, t0 + 10 * 3600 * 1000)).not.toThrow(); // 10h offline gap
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, t0, t0 + 10 * 3600 * 1000);
    expect(s2.run.tiers[0].ready).toBeGreaterThan(0); // job accrual was simply skipped, production still ran
  });

  it('priorityspinup tape upgrade speeds up offline job accrual', () => {
    const s = initialState();
    s.meta.coldStorage.upgrades.priorityspinup = 10; // +100% -> 2x rate
    s.meta.coldStorage.job = { type: 'index', accruedOfflineSec: 0, startedAt: 1_000_000 }; // 8h job
    const t0 = 1_000_000;
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, t0, t0 + 4 * 3600 * 1000); // 4h real offline time
    expect(s2.meta.coldStorage.job.accruedOfflineSec).toBeCloseTo(8 * 3600, 0); // completes in half the real time
  });

  it('coldfusion tape upgrade multiplies production', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 10, manager: true, ready: 0 };
    s.meta.coldStorage.upgrades.coldfusion = 15; // +30%
    const t0 = 1_000_000;
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, t0, t0 + 30_000); // 30s online
    const baseline = initialState();
    baseline.run.tiers[0] = { id: 0, owned: 10, manager: true, ready: 0 };
    const { state: sBaseline } = evaluate(baseline, DEFAULT_CONFIG, t0, t0 + 30_000);
    expect(s2.run.credits).toBeGreaterThan(sBaseline.run.credits);
    expect(s2.run.credits - 10).toBeCloseTo((sBaseline.run.credits - 10) * 1.3, 1);
  });

  it('deepuptime tape upgrade extends the offline production cap', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 10, manager: false, ready: 0 };
    s.meta.coldStorage.upgrades.deepuptime = 10; // +5h -> cap becomes 9h (base 4h + 5h)
    const t0 = 1_000_000;
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, t0, t0 + 20 * 3600 * 1000); // 20h offline
    expect(s2.run.tiers[0].ready).toBeCloseTo(10 * 0.5 * 9 * 3600, 0); // capped at 9h, not the base 4h
  });
});

describe('evaluate with outages (v1.11)', () => {
  const outage = (startAt, endAt, factor, scope) => ({
    id: `x${startAt}`, kind: 'test', scope, factor, startAt, endAt, source: 'hazard',
  });

  it('zero outages leaves online production identical to today', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 10, manager: true, ready: 0 };
    const t0 = 1_000_000;
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, t0, t0 + 30_000);
    expect(s2.run.credits).toBeCloseTo(10 + 150);
    expect(s2.server.outages).toEqual([]);
  });

  it('a full-window outage at 0 stops that lane dead', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 10, manager: true, ready: 0 };
    const t0 = 1_000_000;
    s.server.outages = [outage(t0, t0 + 30_000, 0, { lane: 'tiers', index: 0 })];
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, t0, t0 + 30_000);
    expect(s2.run.credits).toBeCloseTo(10);
  });

  it('half a window dark pays exactly half', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 10, manager: true, ready: 0 };
    const t0 = 1_000_000;
    s.server.outages = [outage(t0 + 15_000, t0 + 30_000, 0, { lane: '*' })];
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, t0, t0 + 30_000);
    expect(s2.run.credits).toBeCloseTo(10 + 75);
  });

  it('the offline cap samples the WHOLE absence proportionally', () => {
    // 12h absent, 4h capped payout, an outage covering 6h of the absence.
    // The credited amount is the 4h payout * 0.5, NOT the first 4h unaffected.
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 10, manager: true, ready: 0 };
    const t0 = 1_000_000;
    const twelveH = 12 * 3600 * 1000;
    s.server.outages = [outage(t0 + 6 * 3600 * 1000, t0 + twelveH, 0, { lane: '*' })];
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, t0, t0 + twelveH);
    // 4h cap * 10 pis * 0.5 F/s = 72000, halved by the sampled factor
    expect(s2.run.credits).toBeCloseTo(10 + 36000);
  });

  it('Cold Storage is untouched by a wildcard outage', () => {
    const mk = () => {
      const s = initialState();
      s.meta.coldStorage.job = { type: 'defrag', accruedOfflineSec: 0, startedAt: 0 };
      return s;
    };
    const t0 = 1_000_000;
    const twelveH = 12 * 3600 * 1000;
    const clean = evaluate(mk(), DEFAULT_CONFIG, t0, t0 + twelveH).state;
    const hit = mk();
    hit.server.outages = [outage(t0, t0 + twelveH, 0, { lane: '*' })];
    const dark = evaluate(hit, DEFAULT_CONFIG, t0, t0 + twelveH).state;
    expect(dark.meta.coldStorage.job.accruedOfflineSec)
      .toBe(clean.meta.coldStorage.job.accruedOfflineSec);
    expect(dark.meta.coldStorage.tapes).toBe(clean.meta.coldStorage.tapes);
  });

  it('prunes outages that ended before now', () => {
    const s = initialState();
    const t0 = 1_000_000;
    s.server.outages = [outage(t0, t0 + 1000, 0, { lane: '*' })];
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, t0, t0 + 30_000);
    expect(s2.server.outages).toEqual([]);
  });

  it('migrateSave defaults and shape-pins the v1.11 server fields', () => {
    const pre = { run: { credits: 5 }, meta: {}, server: { outages: 'not-an-array' } };
    const s = migrateSave(pre);
    expect(s.server.outages).toEqual([]);
    expect(s.server.nextHazardAt).toBe(0);
    expect(s.server.gridMaintenance).toBeNull();
  });
});
