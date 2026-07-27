// Client-only presentation layer over @shared/gameData.js: the shared defs
// carry every numeric/economic field (id, name, baseCost, baseProd, ...);
// this file's only job is attaching a lucide-react Icon per index and
// re-exporting. No economic data is duplicated here.
import {
  Cpu, HardDrive, Server, Database, Building2, Factory, Cloud, Landmark,
  Satellite, Sun, Moon, Radio, Orbit, Atom,
  Users, Wifi, GraduationCap, Briefcase, Globe,
  Wind, Droplets, Waves, Snowflake, Sparkles,
} from 'lucide-react';
import {
  TIER_DEFS as SHARED_TIER_DEFS,
  GRID_DEFS as SHARED_GRID_DEFS,
  OVERCLOCK_DEFS as SHARED_OVERCLOCK_DEFS,
} from '@shared/gameData.js';

const TIER_ICONS = [
  Cpu, HardDrive, Server, Database, Building2, Factory, Cloud, Landmark,
  Satellite, Sun, Moon, Radio, Orbit, Atom,
];
const GRID_ICONS = [Users, Wifi, GraduationCap, Briefcase, Globe];
const OVERCLOCK_ICONS = [Wind, Droplets, Waves, Snowflake, Sparkles];

export const TIER_DEFS = SHARED_TIER_DEFS.map((d, i) => ({ ...d, Icon: TIER_ICONS[i] }));
export const GRID_DEFS = SHARED_GRID_DEFS.map((d, i) => ({ ...d, Icon: GRID_ICONS[i] }));
export const OVERCLOCK_DEFS = SHARED_OVERCLOCK_DEFS.map((d, i) => ({ ...d, Icon: OVERCLOCK_ICONS[i] }));
