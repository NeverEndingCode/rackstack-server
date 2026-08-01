import {
  RefreshCw, Sparkles, Gift, Archive, Layers, ChevronsUp, Cpu,
  Gamepad2, Trophy, Crown, Flame, ClipboardCheck, ListChecks, Award,
} from 'lucide-react';

// Maps the icon NAME strings carried by shared/achievements.js's
// ACHIEVEMENT_DEFS to real components. The names live in shared/ (which must
// not import from client/, and must stay dependency-free), so this map is the
// one place the two sides meet.
const ACHIEVEMENT_ICONS = {
  RefreshCw, Sparkles, Gift, Archive, Layers, ChevronsUp, Cpu,
  Gamepad2, Trophy, Crown, Flame, ClipboardCheck, ListChecks,
};

// Award is the fallback for an unmapped name, so adding a def with a new icon
// degrades to a generic badge rather than crashing the panel.
export function achievementIcon(name) {
  return ACHIEVEMENT_ICONS[name] || Award;
}

// Tier accents, reused by the badge case and the leaderboard's mini-icons so
// a gold badge reads the same everywhere it appears.
export const TIER_COLOR = {
  gold: '#E8A33D',    // amber
  silver: '#9FB0C5',
  bronze: '#B87A4B',
};
