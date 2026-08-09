import { Layers, Network, Flame, ShoppingBag, Sparkles, ListChecks, Gamepad2, Archive, Trophy, Users, ShieldAlert } from 'lucide-react';

export const TABS = [
  { id: 'racks', label: 'Racks', Icon: Layers },
  { id: 'grid', label: 'Grid', Icon: Network },
  { id: 'overclock', label: 'Overclock', Icon: Flame },
  { id: 'upgrades', label: 'Upgrades', Icon: ShoppingBag },
  { id: 'singularity', label: 'Singularity', Icon: Sparkles },
  { id: 'goals', label: 'Goals', Icon: ListChecks },
  { id: 'games', label: 'Games', Icon: Gamepad2 },
  { id: 'coldstorage', label: 'Cold Storage', Icon: Archive },
  // Social (v1.5): contracts, leaderboards and the badge case. Unlike
  // grid/overclock/singularity/coldstorage, this one is never locked - the
  // daily contracts board and the streak both work from level 0, so there's
  // no progression gate to render it disabled behind (see TabBar.jsx).
  { id: 'social', label: 'Social', Icon: Users },
  // Risk & Reliability (v1.11): supplies, the standing risk rate, and any
  // running incident. Never locked - a fresh save can be hit by a hazard, so
  // it must always be able to stock against one.
  { id: 'resilience', label: 'Resilience', Icon: ShieldAlert },
  // Live Events (v1.4): unlike every other tab above (which is locked-but-
  // always-rendered until progression clears it, see TabBar.jsx), this one
  // is entirely absent from the bar outside its window - RackStack.jsx
  // filters it out of the array it hands to TabBar rather than adding a
  // "locked" gate for it, since "an event isn't running" isn't a
  // progression state a player unlocks their way past.
  { id: 'event', label: 'Event', Icon: Trophy },
];
