import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { TOURS, TOUR_IDS, isValidTourId, ONBOARDING_TOUR_ID } from '../shared/tours.js';
import { CLIENT_TOURS } from '../client/src/game/data/tours/index.js';
import { resolveSteps, selectTour } from '../client/src/game/tourSelection.js';

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

const FULL_CTX = {
  gridUnlocked: true, overclockUnlocked: true, singularityUnlocked: true,
  coldStorageUnlocked: true, eventLive: true,
};
const FRESH_CTX = {
  gridUnlocked: false, overclockUnlocked: false, singularityUnlocked: false,
  coldStorageUnlocked: false, eventLive: false,
};

describe('client tour content', () => {
  it('registers exactly the tours in the shared registry', () => {
    expect(Object.keys(CLIENT_TOURS).sort()).toEqual([...TOUR_IDS].sort());
  });

  it('has unique step ids across all tours', () => {
    const ids = Object.values(CLIENT_TOURS).flatMap((t) => t.steps.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every step a title and body', () => {
    for (const tour of Object.values(CLIENT_TOURS)) {
      for (const s of tour.steps) {
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.body.length).toBeGreaterThan(0);
      }
    }
  });

  it('anchors every step at a data-tour attribute that exists in the source', () => {
    const files = [];
    (function walk(dir) {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.jsx$/.test(name)) files.push(full);
      }
    })(path.join(process.cwd(), 'client', 'src'));
    const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');

    for (const tour of Object.values(CLIENT_TOURS)) {
      for (const s of tour.steps) {
        if (!s.anchor) continue;
        // Static form data-tour="x", or the per-tier dynamic form
        // data-tour={i === 0 ? 'x' : undefined} used in RacksPanel.
        const re = new RegExp(`data-tour=(?:"${s.anchor}"|\\{[^}]*'${s.anchor}'[^}]*\\})`);
        expect(re.test(src), `missing data-tour anchor "${s.anchor}" for step ${s.id}`).toBe(true);
      }
    }
  });

  it('drops locked steps for a fresh account and keeps them at full unlock', () => {
    const onboarding = CLIENT_TOURS.onboarding;
    const full = resolveSteps(onboarding, FULL_CTX);
    const fresh = resolveSteps(onboarding, FRESH_CTX);
    expect(full.length).toBe(17);
    expect(fresh.length).toBe(11);
    expect(fresh.every((s) => s.tab !== 'coldstorage')).toBe(true);
    expect(fresh.every((s) => s.tab !== 'event')).toBe(true);
  });
});

describe('tour selection', () => {
  it('selects onboarding for a user who has completed nothing', () => {
    const sel = selectTour(CLIENT_TOURS, TOUR_IDS, [], FRESH_CTX);
    expect(sel.id).toBe(ONBOARDING_TOUR_ID);
    expect(sel.steps.length).toBe(11);
  });

  it('selects nothing once onboarding is complete', () => {
    expect(selectTour(CLIENT_TOURS, TOUR_IDS, [ONBOARDING_TOUR_ID], FULL_CTX)).toBeNull();
  });

  it('ignores ids it does not recognise', () => {
    const sel = selectTour(CLIENT_TOURS, TOUR_IDS, ['v99-future'], FULL_CTX);
    expect(sel.id).toBe(ONBOARDING_TOUR_ID);
  });

  it('skips a tour whose availableWhen fails and picks the next one', () => {
    const tours = {
      locked: { id: 'locked', steps: [{ id: 'a', title: 't', body: 'b' }], availableWhen: (c) => c.coldStorageUnlocked },
      open: { id: 'open', steps: [{ id: 'b', title: 't', body: 'b' }] },
    };
    const sel = selectTour(tours, ['locked', 'open'], [], FRESH_CTX);
    expect(sel.id).toBe('open');
  });

  it('skips a tour that resolves to zero visible steps', () => {
    const tours = {
      empty: { id: 'empty', steps: [{ id: 'a', title: 't', body: 'b', visibleWhen: () => false }] },
      open: { id: 'open', steps: [{ id: 'b', title: 't', body: 'b' }] },
    };
    const sel = selectTour(tours, ['empty', 'open'], [], FRESH_CTX);
    expect(sel.id).toBe('open');
  });

  it('never selects a tour with autoStart false', () => {
    const tours = { manual: { id: 'manual', steps: [{ id: 'a', title: 't', body: 'b' }] } };
    expect(selectTour(tours, ['manual'], [], FRESH_CTX, { manual: false })).toBeNull();
  });
});
