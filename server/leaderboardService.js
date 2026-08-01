// Global leaderboards (v1.5, spec §6.2 + design §8).
//
// Aggregated server-side from CANONICAL SAVES - there are no denormalized
// per-user counters to drift out of sync. That means a rebuild parses every
// user's save JSON, which is why the whole payload sits behind a time-based
// cache: for a friends-server (tens of users) at one rebuild per
// social.leaderboardCacheMs this is negligible, and it keeps saves as the
// single source of truth. If the user count ever made this hot, the fix is
// materialized columns on `users`, not a different cache.

import { getAllUsersWithSaves, listLeaderboard, getLatestEventId } from './db.js';
import { getConfig } from './configService.js';
import { topBadges } from '../shared/achievements.js';

let cache = null; // { generatedAt, boards }

/** Drops the cached payload. Exported for tests and for future admin tooling. */
export function invalidateLeaderboards() {
  cache = null;
}

// Each board is (key, how to read its value off a parsed save's meta).
const BOARDS = [
  ['allTimeFlops', (meta) => (meta.stats && meta.stats.lifetimeFlopsAllTime) || 0],
  ['level', (meta) => meta.level || 0],
  ['legacyCores', (meta) => meta.legacyCores || 0],
  ['singularities', (meta) => (meta.stats && meta.stats.singularities) || 0],
  ['tapes', (meta) => (meta.coldStorage && meta.coldStorage.tapes) || 0],
];

async function buildBoards(limit) {
  const players = [];
  for (const row of await getAllUsersWithSaves()) {
    // The LIVE opt-out column (users.leaderboard_opt_out), the one v1.4
    // shipped for exactly this - never event_participation.opted_out, which is
    // a join-time snapshot that never updates afterwards.
    if (row.leaderboard_opt_out) continue;
    if (!row.data) continue;
    let meta;
    try {
      meta = JSON.parse(row.data).meta;
    } catch {
      continue; // a corrupt save is skipped, never fatal to the whole board
    }
    if (!meta) continue;
    players.push({
      userId: row.id,
      username: row.username,
      avatarUrl: row.avatar_url,
      badges: topBadges(meta.achievements),
      meta,
    });
  }

  const boards = {};
  for (const [key, read] of BOARDS) {
    boards[key] = players
      .map((p) => ({
        userId: p.userId,
        username: p.username,
        avatarUrl: p.avatarUrl,
        badges: p.badges,
        value: read(p.meta),
      }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  }

  // The latest event's board comes from event_participation rather than saves:
  // listLeaderboard already applies the same live opt-out filter and the same
  // ranking the Event tab uses, so the two can never disagree.
  const eventId = await getLatestEventId();
  const badgesByUser = new Map(players.map((p) => [p.userId, p.badges]));
  const avatarByUser = new Map(players.map((p) => [p.userId, p.avatarUrl]));
  boards.latestEventRung = eventId
    ? (await listLeaderboard(eventId, limit)).map((r) => ({
      userId: r.userId,
      username: r.username,
      avatarUrl: avatarByUser.get(r.userId) || null,
      badges: badgesByUser.get(r.userId) || [],
      value: r.rungsClaimed,
    }))
    : [];

  return boards;
}

/**
 * The cached leaderboard payload, rebuilt on the first call after the TTL
 * lapses. Reads getConfig() (the admin baseline) rather than
 * getEffectiveConfig(): the cache TTL and row limit are operational knobs, and
 * letting a live event's overlay quietly change how a SHARED cross-user cache
 * behaves would be surprising.
 */
export async function getLeaderboards(now = Date.now()) {
  const { data: config } = await getConfig();
  if (cache && now - cache.generatedAt < config.social.leaderboardCacheMs) return cache;
  cache = { generatedAt: now, boards: await buildBoards(config.social.leaderboardLimit) };
  return cache;
}
