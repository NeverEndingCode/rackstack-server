import { ClipboardCheck } from 'lucide-react';
import { cardBg, cardBorder, inset, textMain, textDim, teal, amber } from '../../theme.js';
import { fmt } from '../../helpers.js';
import { contractsForState, contractProgress } from '@shared/contracts.js';

// Hh Mm until the next UTC midnight - the same boundary shared/daily.js uses
// for both the contracts board and the streak, so this countdown is exact
// rather than an approximation of "sometime tonight".
function fmtUntilRollover(now) {
  const d = new Date(now);
  const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const totalMin = Math.max(0, Math.ceil((nextMidnight - now) / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

// The three daily contracts. Everything rendered here is derived from
// canonical state via contractsForState/contractProgress - the EXACT functions
// the server's own claimContract runs - so a Claim button can never appear for
// something the server would reject with not_met, and vice versa.
//
// `serverTime` (not Date.now()) drives the rollover countdown: the server owns
// the day boundary, and a client with a skewed clock must not be told the
// board resets at a different moment than it actually will.
export default function ContractsSection({ meta, serverTime, onClaim }) {
  const contracts = contractsForState(meta);

  if (contracts.length === 0) {
    return (
      <div className="rounded-xl p-4 text-sm" style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textDim }}>
        Today&rsquo;s contracts haven&rsquo;t been drawn yet. Reload in a moment.
      </div>
    );
  }

  const claimedCount = contracts.filter((c) => c.claimed).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs font-mono" style={{ color: textDim }}>
        <span>{claimedCount}/{contracts.length} claimed today</span>
        <span>Resets in {fmtUntilRollover(serverTime)}</span>
      </div>

      {contracts.map((c) => {
        const baseline = meta.contracts.baseline[c.def.metric];
        const { current, target, met } = contractProgress(c.def, meta, baseline, c.target);
        const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
        return (
          <div
            key={c.def.id}
            className="rounded-xl p-3"
            style={{
              background: cardBg,
              border: `1px solid ${c.claimed ? teal : cardBorder}`,
              opacity: c.claimed ? 0.6 : 1,
            }}
          >
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold" style={{ color: textMain }}>
                  {c.claimed ? '✓ ' : ''}{c.def.desc(target, fmt)}
                </div>
                <div className="text-xs font-mono mt-0.5" style={{ color: textDim }}>
                  {c.claimed ? 'Claimed' : `${fmt(current)}/${fmt(target)}`}
                </div>
              </div>
              {!c.claimed && met && (
                <button
                  onClick={() => onClaim(c.index)}
                  className="rounded-lg px-3 py-2 text-xs font-semibold shrink-0"
                  style={{ background: amber, color: '#0E141B' }}
                >
                  Claim
                </button>
              )}
            </div>
            {!c.claimed && (
              <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: inset }}>
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: met ? amber : teal }} />
              </div>
            )}
          </div>
        );
      })}

      <div className="text-xs mt-1 flex items-start gap-1.5" style={{ color: textDim }}>
        <ClipboardCheck size={13} className="shrink-0 mt-0.5" />
        <span>Everyone gets the same three contracts each day &mdash; the numbers scale to your own progress.</span>
      </div>
    </div>
  );
}
