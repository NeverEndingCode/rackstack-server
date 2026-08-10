#!/usr/bin/env python3
"""Generate a candidate `shared/` variant with the v1.12 rebalance applied.

  python3 tools/mksandbox.py <outdir> RATIO BASE MIGRATE_EXP CORE_CAP [MIGRATE_DIVISOR]

Every edit here corresponds to a numbered section of
docs/superpowers/specs/2026-08-09-economy-rebalance-design.md.
"""
import json, math, os, re, shutil, sys

out, RATIO, BASE, MEXP, CAP = (sys.argv[1], float(sys.argv[2]), float(sys.argv[3]),
                               float(sys.argv[4]), int(sys.argv[5]))
MDIV = float(sys.argv[6]) if len(sys.argv) > 6 else 1e9
GROWTH = float(sys.argv[7]) if len(sys.argv) > 7 else None
SPC = float(sys.argv[8]) if len(sys.argv) > 8 else None   # shards per core
ENGMAX = int(sys.argv[9]) if len(sys.argv) > 9 else None  # Singularity Engine max level
src = os.path.join(os.path.dirname(__file__), '..', 'shared')
if os.path.exists(out):
    shutil.rmtree(out)
shutil.copytree(src, out)

def edit(fname, subs, required=True):
    p = os.path.join(out, fname)
    s = open(p).read()
    for old, new in subs:
        if old not in s:
            if required:
                raise SystemExit(f'!! {fname}: pattern not found: {old[:90]}')
            continue
        s = s.replace(old, new, 1)
    open(p, 'w').write(s)

# ---- §4.1 tier cost curve: hold baseProd, re-derive baseCost ---------------
p = os.path.join(out, 'gameData.js')
s = open(p).read()
prods, lines, i = [], s.split('\n'), 0
for ln in lines:
    m = re.match(r"\s*\{ id: (\d+), name: '[^']*', baseCost: (\d+), baseProd: ([0-9.]+),", ln)
    if m and 'managerCost' in ln:
        prods.append((int(m.group(1)), float(m.group(3))))
newcost = {}
for idx, prod in prods:
    c = prod * BASE * (RATIO ** idx)
    mag = 10 ** (math.floor(math.log10(c)) - 1)
    newcost[idx] = int(round(c / mag) * mag)
outl = []
for ln in lines:
    m = re.match(r"\s*\{ id: (\d+), name: '[^']*', baseCost: (\d+), baseProd: ", ln)
    if m and 'managerCost' in ln:
        ln = re.sub(r'baseCost: \d+', 'baseCost: %d' % newcost[int(m.group(1))], ln, count=1)
    outl.append(ln)
open(p, 'w').write('\n'.join(outl))

# ---- within-tier depth: GROWTH (optional 7th arg) --------------------------
if GROWTH is not None:
    edit('gameData.js', [("export const GROWTH = 1.14;", "export const GROWTH = %s;" % GROWTH)])

# ---- §4.3(c) re-price the shard tree --------------------------------------
edit('gameData.js', [
    ("{ id: 'engine', name: 'Singularity Engine', desc: '+50% output on every lane per level', baseCost: 6, costMult: 2.6, maxLevel: 8 }",
     "{ id: 'engine', name: 'Singularity Engine', desc: '+50% output on every lane per level', baseCost: 6, costMult: 1.9, maxLevel: 8 }"),
    ("{ id: 'echocores', name: 'Echo Cores', desc: 'Instantly regain 1 free Legacy Core per level after every Migrate', baseCost: 4, costMult: 2.3, maxLevel: 10 }",
     "{ id: 'echocores', name: 'Echo Cores', desc: 'Instantly regain +5% of Migrate gain per level', baseCost: 4, costMult: 1.8, maxLevel: 10 }"),
])

# ---- §4.2/§4.4/§4.5/§4.7 config + new §4.8 tunables ------------------------
edit('configSchema.js', [
    ("heat: { capacity: 2000, ventPercent: 25, ventCooldownMs: 2500, overheatCooldownMs: 10000, overheatPopupMs: 15000 },",
     "heat: { capacity: 2000, ventPercent: 35, ventCooldownMs: 15000, overheatCooldownMs: 10000, overheatPopupMs: 15000,\n         autoVentPerLevel: 4.0, thermalPerLevel: 0.05, heatsinkPerLevel: 0.15, discountFloor: 0.40 },"),
    ("anomaly: { windowMs: 15000, minDelayMs: 70000, maxDelayMs: 150000 },",
     "anomaly: { windowMs: 30000, minDelayMs: 420000, maxDelayMs: 900000,\n            creditsSecondsMin: 30, creditsSecondsMax: 90,\n            boostDurationMinMs: 45000, boostDurationMaxMs: 75000,\n            boostMultMin: 1.5, boostMultMax: 3.0 },"),
    ("  production: { globalMult: 1, racksMult: 1, gridMult: 1, overclockMult: 1 },",
     "  production: { globalMult: 1, racksMult: 1, gridMult: 1, overclockMult: 1,\n                levelBonusPerLevel: 0.02, levelBonusMaxLevel: 200 },\n  prestige: { migrateDivisor: %.6g, migrateExponent: %s, corePercentPerCore: 0.05,\n              coreBonusCap: %d, echoPercentPerLevel: 0.05, shardsPerCore: %s }," % (MDIV, MEXP, CAP, SPC if SPC else 0.4)),
    ("    winCooldownMs: 30000,", "    winCooldownMs: 300000,"),
    ("rush:  { durationSec: 10, waferDivisor: 4, maxTapsPerSec: 15 },",
     "rush:  { durationSec: 10, waferDivisor: 6, maxTapsPerSec: 15 },"),
    ("debug: { durationSec: 15, spawnMinMs: 400, spawnMaxMs: 900, maxLit: 3, waferDivisor: 2 },",
     "debug: { durationSec: 15, spawnMinMs: 400, spawnMaxMs: 900, maxLit: 3, waferDivisor: 3 },"),
    ("balance: { durationSec: 12, safeZoneMin: 35, safeZoneMax: 65, riskZoneWidth: 4,",
     "balance: { durationSec: 12, waferPerPoint: 0.20, safeZoneMin: 35, safeZoneMax: 65, riskZoneWidth: 4,"),
    ("hazardMinDelayMs: 14400000,   // 4h", "hazardMinDelayMs: 7200000,    // 2h"),
    ("hazardMaxDelayMs: 28800000,   // 8h", "hazardMaxDelayMs: 14400000,   // 4h"),
    ("ransomwareFactor: 0.5,", "ransomwareFactor: 0.35,"),
    ("ransomwareDurationMs: 1800000,    // 30m, all lanes at half", "ransomwareDurationMs: 2700000,    // 45m"),
    ("ispOutageDurationMs: 900000,      // 15m, Grid dark", "ispOutageDurationMs: 2400000,     // 40m"),
    ("driveFailureDurationMs: 1200000,  // 20m, one rack tier dark", "driveFailureDurationMs: 2700000,  // 45m, top tier"),
    ("antivirusPriceSeconds: 900,", "antivirusPriceSeconds: 500,"),
    ("backupIspPriceSeconds: 600,", "backupIspPriceSeconds: 200,"),
    ("spareDrivesPriceSeconds: 750,", "spareDrivesPriceSeconds: 250,"),
    ("overheatOutageMs: 600000,         // 10m of one rack tier offline",
     "overheatOutageMs: 900000,         // 15m of the top rack tier\n    driveFailureTargetsTopTier: true,\n    overheatTargetsTopTier: true,"),
    # TUNABLES rows for the new paths (§4.8)
    ("  { path: 'risk.overclockBoostGain', label: 'Overclock boost gain', min: 0, max: 100, integer: false },",
     """  { path: 'risk.overclockBoostGain', label: 'Overclock boost gain', min: 0, max: 100, integer: false },
  { path: 'risk.driveFailureTargetsTopTier', label: 'Drive failure hits the top tier', type: 'boolean' },
  { path: 'risk.overheatTargetsTopTier', label: 'Overheat hits the top tier', type: 'boolean' },
  { path: 'heat.autoVentPerLevel', label: 'Auto-vent per level (heat/s)', min: 0, max: 100, integer: false },
  { path: 'heat.thermalPerLevel', label: 'Thermal Regulators per level', min: 0, max: 1, integer: false },
  { path: 'heat.heatsinkPerLevel', label: 'Heat Sink Mastery per level', min: 0, max: 1, integer: false },
  { path: 'heat.discountFloor', label: 'Heat generation discount floor', min: 0, max: 1, integer: false },
  { path: 'anomaly.creditsSecondsMin', label: 'Anomaly credits (min seconds of output)', min: 0, max: 3600, integer: false },
  { path: 'anomaly.creditsSecondsMax', label: 'Anomaly credits (max seconds of output)', min: 0, max: 3600, integer: false },
  { path: 'anomaly.boostDurationMinMs', label: 'Anomaly boost duration min (ms)', min: 0, max: 3600000, integer: true },
  { path: 'anomaly.boostDurationMaxMs', label: 'Anomaly boost duration max (ms)', min: 0, max: 3600000, integer: true },
  { path: 'anomaly.boostMultMin', label: 'Anomaly boost multiplier min', min: 1, max: 100, integer: false },
  { path: 'anomaly.boostMultMax', label: 'Anomaly boost multiplier max', min: 1, max: 100, integer: false },
  { path: 'production.levelBonusPerLevel', label: 'Output bonus per account level', min: 0, max: 1, integer: false },
  { path: 'production.levelBonusMaxLevel', label: 'Account level bonus cap (levels)', min: 1, max: 10000, integer: true },
  { path: 'prestige.migrateDivisor', label: 'Migrate: lifetime divisor', min: 1, max: 1e18, integer: false },
  { path: 'prestige.migrateExponent', label: 'Migrate: gain exponent', min: 0.05, max: 1, integer: false },
  { path: 'prestige.corePercentPerCore', label: 'Output per Legacy Core', min: 0, max: 1, integer: false },
  { path: 'prestige.coreBonusCap', label: 'Legacy Core bonus cap (cores)', min: 1, max: 1e9, integer: true },
  { path: 'prestige.echoPercentPerLevel', label: 'Echo Cores: % of gain per level', min: 0, max: 1, integer: false },
  { path: 'minigames.balance.waferPerPoint', label: 'Balance wafers per point', min: 0, max: 100, integer: false },"""),
])

# ---- §4.2/§4.3/§4.5 formula fixes in gameRules -----------------------------
edit('gameRules.js', [
    # §4.3(a) migrate gain
    ("export function migrateGain(lifetimeRun, legacyGainMult) {\n  return Math.floor(Math.sqrt(lifetimeRun / 1e6) * legacyGainMult);\n}",
     "export function migrateGain(lifetimeRun, legacyGainMult, config) {\n"
     "  if (!(lifetimeRun > 0)) return 0;\n"
     "  const p = (config && config.prestige) || { migrateDivisor: %g, migrateExponent: %s };\n"
     "  return Math.floor(Math.pow(lifetimeRun / p.migrateDivisor, p.migrateExponent) * legacyGainMult);\n}" % (MDIV, MEXP)),
    # §4.3(c) bootstrap
    ("bootstrapMult: Math.pow(10, sv.bootstrap || 0),", "bootstrapMult: Math.pow(3, sv.bootstrap || 0),"),
    # §4.5 heat, now config-driven
    ("heatDiscount: Math.max(0.15, 1 - 0.08 * (lv.thermal || 0) - 0.25 * (sv.heatsink || 0)),",
     "heatDiscount: Math.max(config.heat.discountFloor,\n      1 - config.heat.thermalPerLevel * (lv.thermal || 0) - config.heat.heatsinkPerLevel * (sv.heatsink || 0)),"),
    ("autoVentPerSec: 0.5 * (lv.autovent || 0),", "autoVentPerSec: config.heat.autoVentPerLevel * (lv.autovent || 0),"),
    # §4.8 capped level bonus
    ("levelBonusMult: 1 + 0.02 * (meta.level || 0),",
     "levelBonusMult: 1 + config.production.levelBonusPerLevel\n      * Math.min(meta.level || 0, config.production.levelBonusMaxLevel),"),
    # §4.3(b) THE CORE CAP - the untested fix
    ("  const base = (1 + (meta.legacyCores || 0) * 0.05) * eff.firmwareMult * eff.engineMult",
     "  const pr = config.prestige;\n"
     "  const coreMult = 1 + pr.corePercentPerCore * Math.min(meta.legacyCores || 0, pr.coreBonusCap);\n"
     "  const base = coreMult * eff.firmwareMult * eff.engineMult"),
    # §4.7 balance minigame coefficient
    ("if (game === 'balance') return Math.max(1, Math.floor(metric * 1.5 * lucky));",
     "if (game === 'balance') return Math.max(1, Math.floor(metric * mg.balance.waferPerPoint * lucky));"),
])

# ---- §4.2 anomaly + §4.3(c) echo cores in the reducer ----------------------
edit('reducer.js', [
    ("    const mult = [2, 3, 4][Math.floor(rng() * 3)];\n    const duration = (45 + rng() * 30) * eff.eventRewardMult;",
     "    const ab = config.anomaly;\n"
     "    const mult = ab.boostMultMin + rng() * (ab.boostMultMax - ab.boostMultMin);\n"
     "    const duration = (ab.boostDurationMinMs + rng() * (ab.boostDurationMaxMs - ab.boostDurationMinMs)) / 1000;"),
    ("    const seconds = 30 + rng() * 60;",
     "    const seconds = config.anomaly.creditsSecondsMin\n      + rng() * (config.anomaly.creditsSecondsMax - config.anomaly.creditsSecondsMin);"),
    # migrateGain now takes config
    ("  const gain = migrateGain(s.run.lifetimeRun, eff.legacyGainMult);",
     "  const gain = migrateGain(s.run.lifetimeRun, eff.legacyGainMult, config);"),
    # echo cores proportional, not flat
    ("  const echoBonus = eff.echoCoresBonus || 0;",
     "  const echoBonus = Math.floor(gain * config.prestige.echoPercentPerLevel * (eff.echoCoresBonus || 0));"),
])

# ---- §4.3(e) lengthen the shard tree's tail --------------------------------
# A4 (tier 13 reachable) needs the Engine multiplier; A8 (tree not maxed in 45
# days) needs a big denominator. With the shipped 8-level Engine the two are
# mutually exclusive, so give Engine a longer tail: the early levels stay cheap
# enough to power the late tiers, while the tail keeps the tree a long goal.
if ENGMAX is not None:
    edit('gameData.js', [("costMult: 1.9, maxLevel: 8 }", "costMult: 1.9, maxLevel: %d }" % ENGMAX)])
    edit('configSchema.js', [("engine: 8,", "engine: %d," % ENGMAX)])

# ---- §4.3(d) Singularity yield: linear in cores, not sqrt ------------------
# With legacyCores hard-capped (§4.3b), floor(sqrt(cores)) yields ~22 shards
# against a ~3.6k-shard tree, so the tree can never progress. Make the rate a
# tunable instead.
edit('reducer.js', [
    ("function singularity(s) {\n  const shardsGained = Math.floor(Math.sqrt(s.meta.legacyCores || 0));",
     "function singularity(s, action, config) {\n  const shardsGained = Math.floor((s.meta.legacyCores || 0) * config.prestige.shardsPerCore);"),
])
edit('configSchema.js', [
    ("  { path: 'prestige.echoPercentPerLevel', label: 'Echo Cores: % of gain per level', min: 0, max: 1, integer: false },",
     "  { path: 'prestige.echoPercentPerLevel', label: 'Echo Cores: % of gain per level', min: 0, max: 1, integer: false },\n"
     "  { path: 'prestige.shardsPerCore', label: 'Singularity: shards per Legacy Core', min: 0, max: 10, integer: false },"),
])

# ---- §4.4 drive failure / overheat target the top owned tier ---------------
edit('outages.js', [
    ("    scope = { lane: 'tiers', index: owned[Math.floor(unitAt(scheduledAt, 1) * owned.length)] };",
     "    scope = { lane: 'tiers', index: config.risk.driveFailureTargetsTopTier\n      ? owned[owned.length - 1]\n      : owned[Math.floor(unitAt(scheduledAt, 1) * owned.length)] };"),
    ("  const index = owned[Math.floor(unitAt(now, 2) * owned.length)];",
     "  const index = config.risk.overheatTargetsTopTier\n    ? owned[owned.length - 1]\n    : owned[Math.floor(unitAt(now, 2) * owned.length)];"),
])

print(f'{out}: RATIO={RATIO} BASE={BASE} mExp={MEXP} coreCap={CAP} mDiv={MDIV:g} growth={GROWTH} '
      f'tier13={newcost[13]:.3g}')
