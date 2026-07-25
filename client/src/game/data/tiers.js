import {
  Cpu, HardDrive, Server, Database, Building2, Factory, Cloud, Landmark,
  Satellite, Sun, Moon, Radio, Orbit, Atom,
  Users, Wifi, GraduationCap, Briefcase, Globe,
  Wind, Droplets, Waves, Snowflake, Sparkles,
} from 'lucide-react';

export const TIER_DEFS = [
  { id: 0, name: 'Spare Raspberry Pi', Icon: Cpu, baseCost: 4, baseProd: 0.5, managerCost: 500 },
  { id: 1, name: 'Refurbished Gaming Rig', Icon: HardDrive, baseCost: 60, baseProd: 6, managerCost: 6000 },
  { id: 2, name: 'Home NAS Tower', Icon: Server, baseCost: 720, baseProd: 45, managerCost: 70000 },
  { id: 3, name: 'Colo Rack Unit', Icon: Database, baseCost: 8800, baseProd: 320, managerCost: 900000 },
  { id: 4, name: 'Server Room', Icon: Building2, baseCost: 110000, baseProd: 2200, managerCost: 12000000 },
  { id: 5, name: 'Regional Data Center', Icon: Factory, baseCost: 1400000, baseProd: 16000, managerCost: 170000000 },
  { id: 6, name: 'Cloud Availability Zone', Icon: Cloud, baseCost: 20000000, baseProd: 120000, managerCost: 2400000000 },
  { id: 7, name: 'Hyperscale Campus', Icon: Landmark, baseCost: 330000000, baseProd: 900000, managerCost: 40000000000 },
  { id: 8, name: 'Orbital Compute Platform', Icon: Satellite, baseCost: 5000000000, baseProd: 7000000, managerCost: 650000000000 },
  { id: 9, name: 'Dyson Swarm Cluster', Icon: Sun, baseCost: 80000000000, baseProd: 55000000, managerCost: 10000000000000 },
  { id: 10, name: 'Lunar Compute Colony', Icon: Moon, baseCost: 1250000000000, baseProd: 430000000, managerCost: 160000000000000 },
  { id: 11, name: 'Interstellar Relay Farm', Icon: Radio, baseCost: 19000000000000, baseProd: 3300000000, managerCost: 2400000000000000 },
  { id: 12, name: 'Galactic Mesh Network', Icon: Orbit, baseCost: 300000000000000, baseProd: 26000000000, managerCost: 37000000000000000 },
  { id: 13, name: 'Quantum Foam Harvester', Icon: Atom, baseCost: 4600000000000000, baseProd: 200000000000, managerCost: 580000000000000000 },
];

export const GRID_DEFS = [
  { id: 0, name: 'Home Volunteer', Icon: Users, baseCost: 50, baseProd: 3 },
  { id: 1, name: "Internet Cafe Node", Icon: Wifi, baseCost: 900, baseProd: 28 },
  { id: 2, name: 'University Cluster', Icon: GraduationCap, baseCost: 15000, baseProd: 220 },
  { id: 3, name: 'Corporate Donor Farm', Icon: Briefcase, baseCost: 260000, baseProd: 1800 },
  { id: 4, name: 'Global BOINC Alliance', Icon: Globe, baseCost: 4500000, baseProd: 15000 },
];

export const OVERCLOCK_DEFS = [
  { id: 0, name: 'Air-Cooled Overclock Rig', Icon: Wind, baseCost: 300, baseProd: 40, heatPerSec: 0.15 },
  { id: 1, name: 'Liquid-Cooled Blade', Icon: Droplets, baseCost: 5500, baseProd: 320, heatPerSec: 0.22 },
  { id: 2, name: 'Immersion Tank Cluster', Icon: Waves, baseCost: 95000, baseProd: 2600, heatPerSec: 0.30 },
  { id: 3, name: 'Cryo-Chilled Array', Icon: Snowflake, baseCost: 1600000, baseProd: 21000, heatPerSec: 0.40 },
  { id: 4, name: 'Superconducting Core', Icon: Sparkles, baseCost: 28000000, baseProd: 170000, heatPerSec: 0.55 },
];
