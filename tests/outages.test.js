import { describe, it, expect } from 'vitest';
import {
  scopeCovers, activeAt, pruneExpired, effectiveFactor, laneOutageFor,
  hazardFrom, scheduleNextHazard, fireDueHazards, hazardRatePerHour, riskOn,
  HAZARD_KINDS, MAX_HAZARDS_PER_EVALUATION,
  SUPPLY_IDS, SUPPLY_FOR_KIND, supplyPrice, cureCost,
  scheduleGridMaintenance, activateDueMaintenance, overheatOutage,
} from '../shared/outages.js';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { initialState } from '../shared/state.js';

function stocked() {
  const s = initialState();
  s.run.tiers[0] = { id: 0, owned: 10, manager: true, ready: 0 };
  s.run.tiers[3] = { id: 3, owned: 4, manager: true, ready: 0 };
  s.run.grid[0] = { id: 0, owned: 5 };
  return s;
}

const at = (startAt, endAt, factor, scope, extra = {}) => ({
  id: `o${startAt}-${endAt}`, kind: 'test', scope, factor, startAt, endAt,
  source: 'hazard', ...extra,
});

describe('scopeCovers', () => {
  it('a wildcard covers every lane and index', () => {
    expect(scopeCovers({ lane: '*' }, 'tiers', 3)).toBe(true);
    expect(scopeCovers({ lane: '*' }, 'grid', 0)).toBe(true);
  });
  it('a bare lane scope covers every index in that lane only', () => {
    expect(scopeCovers({ lane: 'grid' }, 'grid', 4)).toBe(true);
    expect(scopeCovers({ lane: 'grid' }, 'tiers', 4)).toBe(false);
  });
  it('an indexed scope covers exactly one index', () => {
    expect(scopeCovers({ lane: 'tiers', index: 2 }, 'tiers', 2)).toBe(true);
    expect(scopeCovers({ lane: 'tiers', index: 2 }, 'tiers', 3)).toBe(false);
  });
  it('never covers coldstorage, whatever the scope', () => {
    expect(scopeCovers({ lane: '*' }, 'coldstorage', 0)).toBe(false);
  });
});

describe('effectiveFactor', () => {
  it('is exactly 1 with no outages', () => {
    expect(effectiveFactor([], 'tiers', 0, 0, 1000)).toBe(1);
    expect(effectiveFactor(undefined, 'tiers', 0, 0, 1000)).toBe(1);
  });

  it('an outage entirely outside the window contributes nothing', () => {
    const o = [at(5000, 6000, 0, { lane: '*' })];
    expect(effectiveFactor(o, 'tiers', 0, 0, 1000)).toBe(1);
    expect(effectiveFactor(o, 'tiers', 0, 7000, 8000)).toBe(1);
  });

  it('an outage covering the whole window is its factor', () => {
    const o = [at(0, 1000, 0.5, { lane: '*' })];
    expect(effectiveFactor(o, 'tiers', 0, 0, 1000)).toBe(0.5);
  });

  it('one straddling an edge contributes exactly its overlap', () => {
    // 0-factor over [500,1500); window [0,1000) -> half the window dark.
    const o = [at(500, 1500, 0, { lane: '*' })];
    expect(effectiveFactor(o, 'tiers', 0, 0, 1000)).toBeCloseTo(0.5, 12);
    // and the leading edge, same shape
    const p = [at(-500, 500, 0, { lane: '*' })];
    expect(effectiveFactor(p, 'tiers', 0, 0, 1000)).toBeCloseTo(0.5, 12);
  });

  it('overlapping outages multiply inside the overlap', () => {
    // [0,1000) at 0.5 everywhere, plus [0,500) at 0.5 -> 0.25 then 0.5
    const o = [at(0, 1000, 0.5, { lane: '*' }), at(0, 500, 0.5, { lane: 'tiers' })];
    // (500*0.25 + 500*0.5) / 1000
    expect(effectiveFactor(o, 'tiers', 0, 0, 1000)).toBeCloseTo(0.375, 12);
  });

  it('ransomware during an ISP outage leaves Grid at 0 and racks at 0.5', () => {
    const o = [at(0, 1000, 0.5, { lane: '*' }), at(0, 1000, 0, { lane: 'grid' })];
    expect(effectiveFactor(o, 'grid', 0, 0, 1000)).toBe(0);
    expect(effectiveFactor(o, 'tiers', 0, 0, 1000)).toBe(0.5);
  });

  it('only the scoped index is affected', () => {
    const o = [at(0, 1000, 0, { lane: 'tiers', index: 2 })];
    expect(effectiveFactor(o, 'tiers', 2, 0, 1000)).toBe(0);
    expect(effectiveFactor(o, 'tiers', 1, 0, 1000)).toBe(1);
  });

  it('a zero-length or inverted window is 1, never NaN', () => {
    const o = [at(0, 1000, 0, { lane: '*' })];
    expect(effectiveFactor(o, 'tiers', 0, 500, 500)).toBe(1);
    expect(effectiveFactor(o, 'tiers', 0, 600, 500)).toBe(1);
  });

  // The closed form must be EXACT, not an approximation - this cross-checks a
  // messy overlapping case against brute-force numeric sampling.
  it('matches a brute-force integral on overlapping, partially-covering outages', () => {
    const messy = [
      at(120, 880, 0.5, { lane: '*' }),
      at(300, 600, 0.25, { lane: 'tiers' }),
      at(700, 1400, 0, { lane: 'tiers', index: 0 }),
    ];
    const N = 200000;
    let acc = 0;
    for (let i = 0; i < N; i++) {
      const t = 1000 * ((i + 0.5) / N);
      let f = 1;
      for (const o of messy) {
        if (scopeCovers(o.scope, 'tiers', 0) && o.startAt <= t && t < o.endAt) f *= o.factor;
      }
      acc += f;
    }
    expect(effectiveFactor(messy, 'tiers', 0, 0, 1000)).toBeCloseTo(acc / N, 4);
  });
});

describe('activeAt / pruneExpired / laneOutageFor', () => {
  it('activeAt is half-open [startAt, endAt)', () => {
    const o = [at(100, 200, 0, { lane: '*' })];
    expect(activeAt(o, 99)).toHaveLength(0);
    expect(activeAt(o, 100)).toHaveLength(1);
    expect(activeAt(o, 199)).toHaveLength(1);
    expect(activeAt(o, 200)).toHaveLength(0);
  });

  it('pruneExpired drops the finished and keeps the running, without mutating', () => {
    const o = [at(0, 100, 0, { lane: '*' }), at(0, 500, 0, { lane: '*' })];
    const kept = pruneExpired(o, 200);
    expect(kept).toHaveLength(1);
    expect(kept[0].endAt).toBe(500);
    expect(o).toHaveLength(2);
  });

  it('laneOutageFor returns the most severe cover, or null', () => {
    const o = [at(0, 500, 0.5, { lane: '*' }), at(0, 500, 0, { lane: 'grid' })];
    expect(laneOutageFor(o, 'grid', 0, 100).factor).toBe(0);
    expect(laneOutageFor(o, 'tiers', 0, 100).factor).toBe(0.5);
    expect(laneOutageFor(o, 'tiers', 0, 900)).toBeNull();
  });
});

describe('hazard derivation', () => {
  it('is deterministic: the same timestamp derives the same hazard twice', () => {
    const s = stocked();
    for (const t of [1_700_000_000_000, 1_700_000_123_456, 999_999_999]) {
      const a = hazardFrom(t, DEFAULT_CONFIG, s);
      const b = hazardFrom(t, DEFAULT_CONFIG, s);
      expect(a).toEqual(b);
    }
  });

  it('produces different hazards across different timestamps', () => {
    const s = stocked();
    const kinds = new Set();
    for (let i = 0; i < 300; i++) {
      const h = hazardFrom(1_700_000_000_000 + i * 997, DEFAULT_CONFIG, s);
      if (h) kinds.add(h.kind);
    }
    expect(kinds.size).toBeGreaterThan(1);
  });

  it('gives every hazard a stable, derived id - never random', () => {
    const s = stocked();
    const h = hazardFrom(1_700_000_000_000, DEFAULT_CONFIG, s);
    expect(h.id).toBe('hazard:1700000000000');
  });

  it('scopes each kind as the spec table says', () => {
    const s = stocked();
    const seen = {};
    for (let i = 0; i < 500; i++) {
      const h = hazardFrom(1_700_000_000_000 + i * 8677, DEFAULT_CONFIG, s);
      if (h) seen[h.kind] = h;
    }
    expect(seen.ransomware.scope).toEqual({ lane: '*' });
    expect(seen.ransomware.factor).toBe(0.35);   // v1.12: softer, but twice as frequent
    expect(seen.ispOutage.scope).toEqual({ lane: 'grid' });
    expect(seen.driveFailure.scope.lane).toBe('tiers');
    // v1.12: the TOP owned tier, not a derived-random one. Still necessarily an
    // OWNED tier - `stocked()` owns 0 and 3, so the victim is 3.
    expect(seen.driveFailure.scope.index).toBe(3);
    for (const h of Object.values(seen)) expect(h.source).toBe('hazard');
  });

  it('never derives a disabled kind', () => {
    const s = stocked();
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.risk.ransomwareEnabled = false;
    cfg.risk.ispOutageEnabled = false;
    for (let i = 0; i < 200; i++) {
      const h = hazardFrom(1_700_000_000_000 + i * 8677, cfg, s);
      if (h) expect(h.kind).toBe('driveFailure');
    }
  });

  it('returns null when every kind is disabled', () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.risk.ransomwareEnabled = false;
    cfg.risk.ispOutageEnabled = false;
    cfg.risk.driveFailureEnabled = false;
    expect(hazardFrom(1_700_000_000_000, cfg, stocked())).toBeNull();
  });
});

describe('hazard scheduling and firing', () => {
  it('scheduleNextHazard lands inside the configured delay band', () => {
    const server = { nextHazardAt: 0 };
    scheduleNextHazard(server, DEFAULT_CONFIG, 1000, () => 0);
    expect(server.nextHazardAt).toBe(1000 + DEFAULT_CONFIG.risk.hazardMinDelayMs);
    scheduleNextHazard(server, DEFAULT_CONFIG, 1000, () => 1);
    expect(server.nextHazardAt).toBe(1000 + DEFAULT_CONFIG.risk.hazardMaxDelayMs);
  });

  it('schedules the NEXT hazard from the fire time, so a long absence fires many', () => {
    const s = stocked();
    const t0 = 1_700_000_000_000;
    s.server.nextHazardAt = t0;
    // 3 days later, with the shortest possible delay each time
    const notices = fireDueHazards(s, DEFAULT_CONFIG, t0 + 3 * 24 * 3600 * 1000, () => 0);
    expect(notices.length).toBeGreaterThan(1);
  });

  it('terminates and reschedules when nextHazardAt is far in the past', () => {
    const s = stocked();
    s.server.nextHazardAt = 1;           // 1970
    const now = 1_700_000_000_000;
    const notices = fireDueHazards(s, DEFAULT_CONFIG, now, () => 0);
    expect(notices.length).toBeLessThanOrEqual(MAX_HAZARDS_PER_EVALUATION);
    expect(s.server.nextHazardAt).toBeGreaterThan(now);
  });

  it('does nothing when hazards are disabled', () => {
    const s = stocked();
    const t0 = 1_700_000_000_000;
    s.server.nextHazardAt = t0;
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.risk.hazardsEnabled = false;
    expect(fireDueHazards(s, cfg, t0 + 1000, () => 0)).toEqual([]);
    expect(s.server.outages).toEqual([]);
  });

  it('never pushes the same hazard id twice', () => {
    const s = stocked();
    const t0 = 1_700_000_000_000;
    s.server.nextHazardAt = t0;
    fireDueHazards(s, DEFAULT_CONFIG, t0 + 1, () => 0);
    s.server.nextHazardAt = t0;          // replay the same instant
    fireDueHazards(s, DEFAULT_CONFIG, t0 + 1, () => 0);
    const ids = s.server.outages.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports a rate, never a next time', () => {
    // v1.12 band 2h-4h -> mean 3h -> 1/3 per hour (was 4h-8h -> 1/6)
    expect(hazardRatePerHour(DEFAULT_CONFIG)).toBeCloseTo(1 / 3, 6);
  });
});

describe('stockpiles absorb hazards at fire time', () => {
  // A timestamp that derives a ransomware hazard, so the test can stock
  // exactly the supply that counters it.
  const ransomwareAt = [...Array(500)].map((_, i) => 1_700_000_000_000 + i * 8677)
    .find((t) => hazardFrom(t, DEFAULT_CONFIG, stocked()).kind === 'ransomware');

  function withStock(counts) {
    const s = stocked();
    s.meta.supplies = { antivirus: 0, backupIsp: 0, spareDrives: 0, ...counts };
    return s;
  }

  it('consumes exactly one supply, applies no penalty, and says so', () => {
    const s = withStock({ antivirus: 2 });
    s.server.nextHazardAt = ransomwareAt;
    const notices = fireDueHazards(s, DEFAULT_CONFIG, ransomwareAt + 1, () => 0);

    expect(s.server.outages).toEqual([]);           // no penalty
    expect(s.meta.supplies.antivirus).toBe(1);      // exactly one consumed
    const n = notices.find((x) => x.absorbed);
    expect(n).toMatchObject({
      kind: 'ransomware', absorbed: true, supply: 'antivirus', remaining: 1,
    });
  });

  it('cannot absorb with an empty stockpile', () => {
    const s = withStock({ antivirus: 0 });
    s.server.nextHazardAt = ransomwareAt;
    fireDueHazards(s, DEFAULT_CONFIG, ransomwareAt + 1, () => 0);
    expect(s.server.outages).toHaveLength(1);
    expect(s.meta.supplies.antivirus).toBe(0);      // never goes negative
  });

  it('every hazard kind maps to a real supply id', () => {
    for (const kind of HAZARD_KINDS) expect(SUPPLY_IDS).toContain(SUPPLY_FOR_KIND[kind]);
  });

  it('prices supplies in seconds of output, with a floor', () => {
    const cfg = DEFAULT_CONFIG;
    expect(supplyPrice('antivirus', cfg, 0)).toBe(cfg.risk.supplyPriceMin);
    expect(supplyPrice('antivirus', cfg, 1000)).toBe(1000 * cfg.risk.antivirusPriceSeconds);
  });
});

describe('the reactive cure is always worse than preparing', () => {
  const haz = (kind, startAt, endAt, factor) => ({
    id: `hazard:${startAt}`, kind, scope: { lane: '*' }, factor,
    startAt, endAt, source: 'hazard',
  });

  it('never costs less than the supply that would have prevented it', () => {
    const cfg = DEFAULT_CONFIG;
    for (const kind of HAZARD_KINDS) {
      for (const rate of [0, 1, 1e3, 1e9]) {
        for (const elapsed of [0, 0.25, 0.5, 0.99]) {
          const start = 1_000_000;
          const end = start + 1_800_000;
          const now = start + (end - start) * elapsed;
          const cure = cureCost(haz(kind, start, end, 0), cfg, rate, now);
          const prep = supplyPrice(SUPPLY_FOR_KIND[kind], cfg, rate);
          expect(cure).toBeGreaterThan(prep);
        }
      }
    }
  });

  it('costs more the more time is left to buy back', () => {
    const cfg = DEFAULT_CONFIG;
    const h = haz('ransomware', 0, 1000, 0.5);
    expect(cureCost(h, cfg, 1000, 100)).toBeGreaterThan(cureCost(h, cfg, 1000, 900));
  });
});

describe('grid maintenance is telegraphed, not sprung', () => {
  it('schedules a window at least the minimum delay ahead', () => {
    const server = { gridMaintenance: null };
    scheduleGridMaintenance(server, DEFAULT_CONFIG, 1000, () => 0);
    expect(server.gridMaintenance.startAt).toBe(1000 + DEFAULT_CONFIG.risk.maintenanceMinDelayMs);
    expect(server.gridMaintenance.endAt - server.gridMaintenance.startAt)
      .toBe(DEFAULT_CONFIG.risk.maintenanceDurationMs);
    expect(server.gridMaintenance.index).toBeGreaterThanOrEqual(0);
  });

  it('does not activate before its start time', () => {
    const s = stocked();
    s.server.gridMaintenance = { index: 2, startAt: 5000, endAt: 6000 };
    expect(activateDueMaintenance(s, DEFAULT_CONFIG, 4999)).toBeNull();
    expect(s.server.outages).toEqual([]);
    expect(s.server.gridMaintenance).not.toBeNull();   // still telegraphed
  });

  it('activates into a scoped, zero-factor outage and clears the slot', () => {
    const s = stocked();
    s.server.gridMaintenance = { index: 2, startAt: 5000, endAt: 6000 };
    const o = activateDueMaintenance(s, DEFAULT_CONFIG, 5000);
    expect(o).toMatchObject({
      kind: 'maintenance', source: 'scheduled', factor: 0,
      scope: { lane: 'grid', index: 2 }, startAt: 5000, endAt: 6000,
      id: 'maintenance:5000',
    });
    expect(s.server.outages).toHaveLength(1);
    expect(s.server.gridMaintenance).toBeNull();
  });

  it('does nothing when maintenance is disabled', () => {
    const s = stocked();
    s.server.gridMaintenance = { index: 2, startAt: 5000, endAt: 6000 };
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.risk.maintenanceEnabled = false;
    expect(activateDueMaintenance(s, cfg, 9000)).toBeNull();
    expect(s.server.outages).toEqual([]);
  });
});

describe('riskOn ANDs the master switch first', () => {
  it('is false whenever the master is off, whatever the source says', () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.risk.enabled = false;
    for (const key of ['hazardsEnabled', 'maintenanceEnabled', 'overheatShutdownEnabled']) {
      cfg.risk[key] = true;
      expect(riskOn(cfg, key)).toBe(false);
    }
  });
  it('is true only when both are on', () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    expect(riskOn(cfg, 'hazardsEnabled')).toBe(true);
    cfg.risk.hazardsEnabled = false;
    expect(riskOn(cfg, 'hazardsEnabled')).toBe(false);
  });
});


function stateWithTiers(indices) {
  const s = initialState();
  for (const i of indices) s.run.tiers[i].owned = 5;
  return s;
}

describe('v1.12 hazards target the top owned tier', () => {
  const driveOnly = () => {
    const c = structuredClone(DEFAULT_CONFIG);
    c.risk.ransomwareEnabled = false;
    c.risk.ispOutageEnabled = false;
    return c;
  };

  it('drive failure always picks the highest owned tier', () => {
    const c = driveOnly();
    const s = stateWithTiers([0, 3, 7]);
    for (const at of [1e12, 1e12 + 137, 1e12 + 9999]) {
      const h = hazardFrom(at, c, s);
      expect(h.kind).toBe('driveFailure');
      expect(h.scope).toEqual({ lane: 'tiers', index: 7 });
    }
  });

  it('the switch restores random targeting, and the two paths really differ', () => {
    const c = driveOnly();
    c.risk.driveFailureTargetsTopTier = false;
    const s = stateWithTiers([0, 3, 7]);
    const times = [1e12, 2e12, 3e12, 4e12, 5e12, 6e12, 7e12, 8e12];
    const picks = new Set(times.map((at) => hazardFrom(at, c, s).scope.index));
    expect([...picks].every((i) => [0, 3, 7].includes(i))).toBe(true);
    // The derived pick must actually vary, otherwise the top-tier assertion
    // above would pass for the wrong reason.
    expect(picks.size).toBeGreaterThan(1);

    const top = driveOnly();
    expect(new Set(times.map((at) => hazardFrom(at, top, s).scope.index))).toEqual(new Set([7]));
  });

  it('overheat downs the top owned tier', () => {
    const s = stateWithTiers([0, 2, 9]);
    const o = overheatOutage(s, DEFAULT_CONFIG, 1e12);
    expect(o.scope).toEqual({ lane: 'tiers', index: 9 });
    expect(o.factor).toBe(0);
    expect(o.endAt - o.startAt).toBe(DEFAULT_CONFIG.risk.overheatOutageMs);
  });

  it('overheat with no owned tier still returns null', () => {
    expect(overheatOutage(initialState(), DEFAULT_CONFIG, 1e12)).toBeNull();
  });
});
