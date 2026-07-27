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
