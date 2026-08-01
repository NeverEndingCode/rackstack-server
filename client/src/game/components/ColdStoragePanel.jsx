import { CassetteTape, Check, Lock, Play, Ban, Gift, RotateCcw } from 'lucide-react';
import { cardBg, cardBorder, inset, textMain, textDim, amber, teal, violet, danger, buyBtnStyle } from '../theme.js';
import { fmt } from '../helpers.js';
import { computeColdStorageEffects, jobDurationSec, jobReward } from '@shared/coldStorage.js';
import { TOTAL_BLOCKS, JOB_TYPES, JOB_LABELS, TAPE_UPGRADE_DEFS } from '../data/coldStorage.js';

// Xh Ym countdown formatting, rounded up to the nearest minute so a tile that
// just missed arriving doesn't briefly read "0h 0m".
function fmtCountdown(ms) {
  const totalMin = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function fmtHours(sec) {
  const h = sec / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

// Note: totalOutputPerSec is passed by RackStack.jsx (mirroring what the
// reducer's blockReward() needs for milestone-block FLOPS payouts) but isn't
// surfaced anywhere in this panel - the brief's tile states (claimed /
// claimable / locked) don't call for a per-block reward preview, unlike the
// job picker below which does preview its reward.
export default function ColdStoragePanel({ meta, config, onClaimBlock, onClaimAllBlocks, onResetTrack, onStartJob, onCancelJob, onClaimJob, onBuyTapeUpgrade }) {
  const cs = meta.coldStorage;
  const csEff = computeColdStorageEffects(meta, config);
  const now = Date.now();

  // Mirrors the reducer's own arrival math exactly (see reducer.js's
  // claimBlock/claimAllBlocks) so the UI's notion of "claimable" never drifts
  // from what the server will actually accept.
  const blocksElapsed = Math.min(TOTAL_BLOCKS, Math.floor((now - cs.trackStartedAt) / csEff.blockDurationMs));
  const anyClaimable = cs.blocksClaimed.some((claimed, i) => !claimed && i < blocksElapsed);
  const allClaimed = cs.blocksClaimed.every(Boolean);
  const msToNextBlock = csEff.blockDurationMs - ((now - cs.trackStartedAt) % csEff.blockDurationMs);

  const job = cs.job;
  const jobDurSec = job ? jobDurationSec(job.type, config) : 0;
  const jobDone = job && job.accruedOfflineSec >= jobDurSec;

  return (
    <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3" data-tour="coldstorage-track">
      <div className="rounded-lg p-3 flex items-center justify-between" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: textMain }}>
          <CassetteTape size={16} color={teal} /> Tapes
        </div>
        <div className="font-mono text-sm font-semibold" style={{ color: teal }}>{fmt(cs.tapes)}</div>
      </div>

      {/* Section A: Passive Track */}
      <div className="rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold" style={{ color: textMain }}>Passive Track</div>
          {blocksElapsed < TOTAL_BLOCKS && (
            <div className="text-xs font-mono" style={{ color: textDim }}>Next block in {fmtCountdown(msToNextBlock)}</div>
          )}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {cs.blocksClaimed.map((claimed, i) => {
            const arrived = i < blocksElapsed;
            const claimable = arrived && !claimed;
            return (
              <button
                key={i}
                onClick={() => claimable && onClaimBlock(i)}
                disabled={!claimable}
                className="rounded-lg aspect-square flex items-center justify-center text-xs font-mono"
                style={{
                  background: claimed ? teal : claimable ? amber : inset,
                  color: claimed || claimable ? '#0E141B' : textDim,
                  border: `1px solid ${cardBorder}`,
                  opacity: arrived || claimed ? 1 : 0.5,
                  cursor: claimable ? 'pointer' : 'not-allowed',
                }}
              >
                {claimed ? <Check size={16} /> : claimable ? i + 1 : <Lock size={12} />}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-2 mt-3">
          <button onClick={onClaimAllBlocks} disabled={!anyClaimable} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(anyClaimable)}>
            Claim All
          </button>
          <button onClick={onResetTrack} disabled={!allClaimed} className="rounded-lg py-2 text-xs font-mono flex items-center justify-center gap-1" style={buyBtnStyle(allClaimed)}>
            <RotateCcw size={12} /> Reset Track
          </button>
        </div>
      </div>

      {/* Section B: Offline Job */}
      <div className="rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
        <div className="text-sm font-semibold mb-2" style={{ color: textMain }}>Offline Job</div>
        {!job && (
          <div className="flex flex-col gap-2">
            {JOB_TYPES.map((type) => {
              const durSec = jobDurationSec(type, config);
              // Reward preview: raw jobReward() times the live effect
              // multiplier, matching exactly what claimJob() actually pays out.
              const reward = Math.round(jobReward(type, config) * csEff.tapeRewardMult);
              return (
                <button
                  key={type}
                  onClick={() => onStartJob(type)}
                  className="rounded-lg p-2 flex items-center justify-between text-left"
                  style={{ background: inset, border: `1px solid ${cardBorder}` }}
                >
                  <div>
                    <div className="text-xs font-semibold" style={{ color: textMain }}>{JOB_LABELS[type]}</div>
                    <div className="text-xs font-mono" style={{ color: textDim }}>{fmtHours(durSec)} &middot; +{fmt(reward)} tapes</div>
                  </div>
                  <Play size={16} color={amber} />
                </button>
              );
            })}
            <div className="text-xs" style={{ color: textDim }}>Progress only advances while you&apos;re offline &mdash; start a job, then check back later.</div>
          </div>
        )}
        {job && (
          <div>
            <div className="text-xs font-semibold mb-1" style={{ color: textMain }}>{JOB_LABELS[job.type]}</div>
            <div className="h-2 rounded" style={{ background: cardBorder }}>
              <div className="h-2 rounded" style={{ background: jobDone ? teal : amber, width: `${Math.min(100, (job.accruedOfflineSec / jobDurSec) * 100)}%` }} />
            </div>
            <div className="text-xs mt-1" style={{ color: textDim }}>
              {jobDone ? 'Job complete — claim your tapes.' : 'Progress only advances while you’re offline — check back after some time away.'}
            </div>
            <div className="mt-2">
              {jobDone ? (
                <button onClick={onClaimJob} className="w-full rounded-lg py-2 text-xs font-mono flex items-center justify-center gap-1" style={buyBtnStyle(true)}>
                  <Gift size={12} /> Claim
                </button>
              ) : (
                <button
                  onClick={onCancelJob}
                  className="w-full rounded-lg py-2 text-xs font-mono flex items-center justify-center gap-1"
                  style={{ background: cardBg, border: `1px solid ${danger}`, color: danger, cursor: 'pointer' }}
                >
                  <Ban size={12} /> Cancel
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Section C: Tape Upgrades */}
      <div className="flex flex-col gap-3">
        <div className="text-xs font-mono uppercase tracking-wide" style={{ color: violet }}>Tape Upgrades</div>
        {TAPE_UPGRADE_DEFS.map((u) => {
          const level = cs.upgrades[u.id] || 0;
          // Max level is read live from config.upgrades.maxLevels (admin-tunable,
          // same source the reducer's buyTapeUpgrade() enforces) rather than the
          // static u.maxLevel on the def. UpgradesPanel.jsx still reads the
          // static def value, which can drift from the live config - a known,
          // separately-tracked issue that is intentionally left alone here.
          const maxLevel = config.upgrades.maxLevels[u.id];
          const maxed = level >= maxLevel;
          const cost = Math.ceil(u.baseCost * Math.pow(u.costMult, level));
          const afford = cs.tapes >= cost;
          return (
            <div key={u.id} className="rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
              <div className="flex items-center justify-between">
                <div className="font-semibold text-sm" style={{ color: textMain }}>{u.name}</div>
                <div className="font-mono text-xs" style={{ color: violet }}>Lv {level}/{maxLevel}</div>
              </div>
              <div className="text-xs mt-0.5" style={{ color: textDim }}>{u.desc}</div>
              <button
                onClick={() => onBuyTapeUpgrade(u)}
                disabled={maxed || !afford}
                className="mt-2 w-full rounded-lg py-2 text-xs font-mono flex items-center justify-center gap-1"
                style={buyBtnStyle(!maxed && afford)}
              >
                {maxed ? 'MAXED' : (<><CassetteTape size={12} /> {fmt(cost)} tapes</>)}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
