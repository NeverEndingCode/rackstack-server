import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { initialState } from '../shared/state.js';
import {
  ACHIEVEMENT_DEFS, achievementDef, checkAchievements, topBadges,
} from '../shared/achievements.js';

const NOW = 1_000_000;

describe('ACHIEVEMENT_DEFS', () => {
  it('has unique ids, a valid tier, and a complete shape', () => {
    const ids = ACHIEVEMENT_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(15);
    for (const d of ACHIEVEMENT_DEFS) {
      expect(typeof d.name).toBe('string');
      expect(d.name.length).toBeGreaterThan(0);
      expect(typeof d.desc).toBe('string');
      expect(typeof d.icon).toBe('string'); // lucide icon NAME, not a component
      expect(['bronze', 'silver', 'gold']).toContain(d.tier);
      expect(typeof d.condition).toBe('function');
    }
  });
  it('carries no reward field of any kind - achievements are pure prestige', () => {
    for (const d of ACHIEVEMENT_DEFS) {
      expect(d.reward).toBeUndefined();
      expect(d.wafers).toBeUndefined();
      expect(d.xp).toBeUndefined();
    }
  });
  it('achievementDef fails closed on prototype keys', () => {
    for (const bad of ['nope', '__proto__', 'toString', 'constructor', '', null, 42]) {
      expect(achievementDef(bad)).toBeNull();
    }
  });
});

describe('checkAchievements', () => {
  it('unlocks nothing on a fresh state', () => {
    const s = initialState();
    expect(checkAchievements(s, DEFAULT_CONFIG, NOW)).toEqual([]);
    expect(s.meta.achievements).toEqual({});
  });

  it('unlocks on a met condition and stamps the unlock time', () => {
    const s = initialState();
    s.meta.stats.singularities = 1;
    const unlocked = checkAchievements(s, DEFAULT_CONFIG, NOW);
    expect(unlocked).toContain('first_singularity');
    expect(s.meta.achievements.first_singularity).toBe(NOW);
  });

  it('never re-unlocks or re-stamps an already-held achievement', () => {
    const s = initialState();
    s.meta.stats.singularities = 1;
    checkAchievements(s, DEFAULT_CONFIG, NOW);
    const second = checkAchievements(s, DEFAULT_CONFIG, NOW + 5000);
    expect(second).not.toContain('first_singularity');
    expect(s.meta.achievements.first_singularity).toBe(NOW); // original stamp kept
  });

  it('pays nothing - no currency or xp moves when an achievement unlocks', () => {
    const s = initialState();
    s.meta.stats.migrates = 1;
    const before = {
      wafers: s.meta.wafers, xp: s.meta.xp, level: s.meta.level,
      credits: s.run.credits, tapes: s.meta.coldStorage.tapes,
    };
    expect(checkAchievements(s, DEFAULT_CONFIG, NOW).length).toBeGreaterThan(0);
    expect(s.meta.wafers).toBe(before.wafers);
    expect(s.meta.xp).toBe(before.xp);
    expect(s.meta.level).toBe(before.level);
    expect(s.run.credits).toBe(before.credits);
    expect(s.meta.coldStorage.tapes).toBe(before.tapes);
  });

  it('unlocks the event-champion badge off the eventTopRungs counter', () => {
    const s = initialState();
    s.meta.stats.eventTopRungs = 1;
    expect(checkAchievements(s, DEFAULT_CONFIG, NOW)).toContain('event_champion');
  });

  it('unlocks the streak badge off bestStreak', () => {
    const s = initialState();
    s.meta.stats.bestStreak = 7;
    expect(checkAchievements(s, DEFAULT_CONFIG, NOW)).toContain('streak_week');
  });

  it('every condition survives a fresh state without throwing', () => {
    const s = initialState();
    expect(() => checkAchievements(s, DEFAULT_CONFIG, NOW)).not.toThrow();
  });

  it('treats a condition that throws on a malformed save as simply unmet', () => {
    const s = initialState();
    delete s.meta.coldStorage; // would throw inside the jackpot/tape conditions
    expect(() => checkAchievements(s, DEFAULT_CONFIG, NOW)).not.toThrow();
    expect(s.meta.achievements.jackpot).toBeUndefined();
  });
});

describe('topBadges', () => {
  it('returns at most three ids, gold first', () => {
    const gold = ACHIEVEMENT_DEFS.filter((d) => d.tier === 'gold')[0];
    const bronze = ACHIEVEMENT_DEFS.filter((d) => d.tier === 'bronze').slice(0, 3);
    const held = {};
    for (const d of [...bronze, gold]) held[d.id] = NOW;
    const badges = topBadges(held);
    expect(badges).toHaveLength(3);
    expect(badges[0]).toBe(gold.id);
  });
  it('ignores unknown ids in a hand-edited save', () => {
    expect(topBadges({ nope: 1 })).toEqual([]);
  });
  it('handles a missing or non-object bag', () => {
    for (const bad of [null, undefined, [], 'x']) expect(topBadges(bad)).toEqual([]);
  });
});
