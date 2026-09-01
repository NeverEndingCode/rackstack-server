import { useSyncExternalStore } from 'react';
import { DEFAULT_CORE_FORMAT, normalizeCoreFormat, nextCoreFormat } from './helpers.js';

// How the player wants Legacy Core counts rendered (see fmtCores in
// shared/gameRules.js). Purely a display preference, so it lives client-side
// in localStorage rather than in canonical server state - nothing about the
// simulation reads it, and there is no migration to run when it changes.
//
// A module-level external store instead of per-component useState: the cores
// chip in the header, the Migrate button, the Singularity panel and the
// Settings picker all render the same preference, and cycling it from the chip
// has to move all of them at once. useSyncExternalStore keeps them in step
// without threading a prop through RackStack.jsx to five places.
const KEY = 'rackstack:coreFormat';

let current = readStored();
const listeners = new Set();

function readStored() {
  try {
    return normalizeCoreFormat(localStorage.getItem(KEY));
  } catch {
    // Private-mode / storage-blocked browsers: fall back to the default rather
    // than taking the whole header down with a SecurityError.
    return DEFAULT_CORE_FORMAT;
  }
}

export function getCoreFormat() {
  return current;
}

export function setCoreFormat(format) {
  const next = normalizeCoreFormat(format);
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Preference still applies for this session, it just won't survive a reload.
  }
  for (const fn of listeners) fn();
}

export function cycleCoreFormat() {
  setCoreFormat(nextCoreFormat(current));
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useCoreFormat() {
  return useSyncExternalStore(subscribe, getCoreFormat, getCoreFormat);
}
