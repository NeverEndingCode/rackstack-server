/**
 * Tour step content, grouped by feature area. These arrays are the reusable
 * unit: a future release's feature tour imports its array here and
 * onboarding.js composes the same array, so tutorial copy is never written
 * twice and the two paths cannot drift.
 *
 * Step shape:
 *   { id, tab, anchor, title, body, visibleWhen? }
 * - `tab`: tab id to switch to first; null = leave the tab alone.
 * - `anchor`: matches data-tour="…"; null = centered card with no spotlight.
 * - `visibleWhen(ctx)`: omit for "always". ctx is
 *   { gridUnlocked, overclockUnlocked, singularityUnlocked,
 *     coldStorageUnlocked, eventLive }.
 */

export const welcomeSteps = [
  {
    id: 'welcome',
    tab: null,
    anchor: null,
    title: 'Welcome to RackStack',
    body: 'You run a compute farm. Racks earn FLOPS, FLOPS buy more racks, and every few minutes something new opens up. This tour takes about a minute - hit Skip any time.',
  },
  {
    id: 'header-stats',
    tab: null,
    anchor: 'header-stats',
    title: 'Your numbers',
    body: 'Your banked FLOPS and how fast you are earning them. Everything you buy raises that rate.',
  },
];

export const racksSteps = [
  {
    id: 'racks-buy',
    tab: 'racks',
    anchor: 'racks-buy',
    title: 'Buy racks',
    body: 'Each rack adds output. Buy one at a time, ten at a time, or Max to spend everything you have. Costs climb as you stack them, and every milestone doubles that tier.',
  },
  {
    id: 'racks-collect',
    tab: 'racks',
    anchor: 'racks-collect',
    title: 'Collect what they earn',
    body: 'Racks bank their output until you collect it. Tap Collect to sweep it into your balance - the button greys out when there is nothing waiting.',
  },
  {
    id: 'racks-automate',
    tab: 'racks',
    anchor: 'racks-automate',
    title: 'Then stop collecting',
    body: 'Automate a tier and it collects itself forever, online or off. This is the real goal of the early game.',
  },
];

export const gridSteps = [
  {
    id: 'grid-intro',
    tab: 'grid',
    anchor: 'grid-buy',
    title: 'The Grid',
    body: 'The Grid runs on its own from the moment you buy it - no collecting. It is your steady baseline while you tinker elsewhere.',
    visibleWhen: (ctx) => ctx.gridUnlocked,
  },
];

export const overclockSteps = [
  {
    id: 'overclock-heat',
    tab: 'overclock',
    anchor: 'overclock-heat',
    title: 'Overclocking runs hot',
    body: 'Overclock nodes out-earn everything else, but they build heat. Hit 100% and the whole lane freezes for a cooldown - you never lose nodes, just time.',
    visibleWhen: (ctx) => ctx.overclockUnlocked,
  },
  {
    id: 'overclock-vent',
    tab: 'overclock',
    anchor: 'overclock-vent',
    title: 'Vent before it bites',
    body: 'Venting sheds a percentage of your heat capacity on a short cooldown. Thermal Regulators and Auto-Vent upgrades buy you slack so you can stop babysitting it.',
    visibleWhen: (ctx) => ctx.overclockUnlocked,
  },
];

export const upgradesSteps = [
  {
    id: 'upgrades-intro',
    tab: 'upgrades',
    anchor: 'upgrades-list',
    title: 'Spend your wafers',
    body: 'Wafers come from goals, minigames and events. Upgrades bought here are permanent multipliers - they are almost always worth buying the moment you can afford them.',
  },
];

export const goalsSteps = [
  {
    id: 'goals-intro',
    tab: 'goals',
    anchor: 'goals-list',
    title: 'Goals and levels',
    body: 'Goals pay XP and wafers for things you were going to do anyway. Every level adds a small permanent output bonus on top.',
  },
];

export const gamesSteps = [
  {
    id: 'games-intro',
    tab: 'games',
    anchor: 'games-list',
    title: 'Minigames for wafers',
    body: 'Four short minigames, each on its own cooldown. They are the fastest wafer income in the game if you enjoy them - and entirely optional if you do not.',
  },
];

export const coldStorageSteps = [
  {
    id: 'coldstorage-intro',
    tab: 'coldstorage',
    anchor: 'coldstorage-track',
    title: 'Cold Storage pays you to leave',
    body: 'This lane only advances while you are away, and it earns Tapes - a currency that survives Migrate and Singularity. Queue a job before you close the tab.',
    visibleWhen: (ctx) => ctx.coldStorageUnlocked,
  },
];

export const socialSteps = [
  {
    id: 'social-intro',
    tab: 'social',
    anchor: 'social-sections',
    title: 'Contracts, boards and badges',
    body: 'Three daily contracts scaled to your own progress, global leaderboards, achievements, and a login streak. Claim the streak from the header each day.',
  },
];

export const singularitySteps = [
  {
    id: 'singularity-intro',
    tab: 'singularity',
    anchor: 'singularity-list',
    title: 'The deep reset',
    body: 'Singularity trades your Legacy Cores for Shards and permanent perks. It is the second prestige layer - slower than Migrate, and far stronger.',
    visibleWhen: (ctx) => ctx.singularityUnlocked,
  },
];

export const migrateSteps = [
  {
    id: 'migrate-intro',
    tab: null,
    anchor: 'migrate-bar',
    title: 'Migrate to go faster',
    body: 'Migrating wipes this run and pays Legacy Cores, which multiply everything afterwards. Resetting is how you progress here, not a setback.',
  },
];

export const eventSteps = [
  {
    id: 'event-intro',
    tab: 'event',
    anchor: 'event-ladder',
    title: 'An event is running',
    body: 'Events retune the game for a while and add a reward ladder. Your window is personal - it starts when you first log in during the event, so you never lose days to being away.',
    visibleWhen: (ctx) => ctx.eventLive,
  },
];

export const wrapUpSteps = [
  {
    id: 'wrap-up',
    tab: null,
    anchor: null,
    title: 'That is the whole rack',
    body: 'Locked tabs open up as you grow. You can replay this tour any time from Profile -> Settings -> Tutorials.',
  },
];

export const resilienceSteps = [
  {
    id: 'resilience-risk',
    tab: 'resilience',
    anchor: 'resilience-risk',
    title: 'Things go wrong',
    body: 'Every few hours something breaks - ransomware, a dead link, a failed drive. It only ever slows you down: you never lose racks, FLOPS, tapes or upgrades. You are told the rate, never the schedule.',
  },
  {
    id: 'resilience-supplies',
    tab: 'resilience',
    anchor: 'resilience-supplies',
    title: 'Stock up before it happens',
    body: 'Each supply absorbs one matching incident automatically - even while you are offline, which is the only time it can save you. Fixing something already broken always costs more than having prepared. Cold Storage is never affected.',
  },
];
