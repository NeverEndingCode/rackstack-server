import { Layers, Network, Flame, ShoppingBag, Sparkles, ListChecks, Gamepad2, Archive, Trophy } from 'lucide-react';

export const TABS = [
  { id: 'racks', label: 'Racks', Icon: Layers },
  { id: 'grid', label: 'Grid', Icon: Network },
  { id: 'overclock', label: 'Overclock', Icon: Flame },
  { id: 'upgrades', label: 'Upgrades', Icon: ShoppingBag },
  { id: 'singularity', label: 'Singularity', Icon: Sparkles },
  { id: 'goals', label: 'Goals', Icon: ListChecks },
  { id: 'games', label: 'Games', Icon: Gamepad2 },
  { id: 'coldstorage', label: 'Cold Storage', Icon: Archive },
  // Live Events (v1.4): unlike every other tab above (which is locked-but-
  // always-rendered until progression clears it, see TabBar.jsx), this one
  // is entirely absent from the bar outside its window - RackStack.jsx
  // filters it out of the array it hands to TabBar rather than adding a
  // "locked" gate for it, since "an event isn't running" isn't a
  // progression state a player unlocks their way past.
  { id: 'event', label: 'Event', Icon: Trophy },
];
