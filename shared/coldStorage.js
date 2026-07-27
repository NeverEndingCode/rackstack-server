import { TOTAL_BLOCKS, JOB_TYPES } from './coldStorageData.js';

const JOB_DURATION_CONFIG_KEY = {
  defrag: 'jobDurationDefragMs',
  index: 'jobDurationIndexMs',
  deep: 'jobDurationDeepMs',
};

export function computeColdStorageEffects(meta, config) {
  const up = (meta.coldStorage && meta.coldStorage.upgrades) || {};
  const bq = config.batchQueue;
  return {
    tapeRewardMult: 1 + 0.05 * (up.compression || 0),
    blockDurationMs: Math.max(4 * 3600000, bq.blockDurationMs - 360000 * (up.robotarm || 0)),
    offlineJobRateMult: 1 + 0.10 * (up.priorityspinup || 0),
    headStartBlocks: up.headstart || 0,
    coldFusionMult: 1 + 0.02 * (up.coldfusion || 0),
    heatCapacityBonus: 100 * (up.heatsinktapes || 0),
    offlineCapHoursBonus: 0.5 * (up.deepuptime || 0),
  };
}

export function blockReward(index, trackCycle, config, csEff, totalOutputPerSec) {
  const bq = config.batchQueue;
  const cycleMult = 1 + bq.blockCycleBonusPct * trackCycle;
  let tapes = bq.blockBaseTapes * (index + 1) * cycleMult;
  if (index === TOTAL_BLOCKS - 1) tapes *= bq.jackpotMultiplier;
  tapes = Math.round(tapes * csEff.tapeRewardMult);

  let flops = 0;
  if ((index + 1) % bq.blockFlopsIntervalBlocks === 0) {
    flops = totalOutputPerSec * bq.blockFlopsSeconds;
  }
  return { tapes, flops };
}

export function jobDurationSec(jobType, config) {
  return config.batchQueue[JOB_DURATION_CONFIG_KEY[jobType]] / 1000;
}

export function jobReward(jobType, config) {
  const bq = config.batchQueue;
  if (jobType === 'defrag') return bq.jobBaseTapes;
  if (jobType === 'index') return bq.jobBaseTapes * bq.jobIndexMultiplier;
  return bq.jobBaseTapes * bq.jobDeepMultiplier; // 'deep'
}
