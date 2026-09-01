import { CircuitBoard, Gem, Sparkles, Trophy, RefreshCw, Gamepad2, ListChecks, Calendar } from 'lucide-react';
import { textMain, textDim, teal, violet, amber } from '../../theme.js';
import { xpForLevel, fmtCores } from '../../helpers.js';
import { useCoreFormat } from '../../coreFormat.js';
import { GOAL_DEFS } from '../../data/goals.js';

function StatRow({ Icon, color, label, value }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="flex items-center gap-2" style={{ color: textDim }}><Icon size={14} color={color} /> {label}</span>
      <span className="font-mono" style={{ color: textMain }}>{value}</span>
    </div>
  );
}

export default function ProfileStats({ meta, memberSince }) {
  const coreFormat = useCoreFormat();
  const xpNeeded = xpForLevel(meta.level);
  const completedCount = Object.keys(meta.goalsCompleted).length;
  const joined = memberSince ? new Date(memberSince).toLocaleDateString() : null;
  return (
    <div>
      <StatRow Icon={Trophy} color={violet} label="Level" value={`${meta.level} (${meta.xp}/${xpNeeded} xp)`} />
      <StatRow Icon={Gem} color={violet} label="Wafers" value={meta.wafers} />
      <StatRow Icon={CircuitBoard} color={teal} label="Legacy Cores" value={fmtCores(meta.legacyCores, coreFormat)} />
      <StatRow Icon={Sparkles} color={violet} label="Singularity Shards" value={meta.singularityShards} />
      <StatRow Icon={RefreshCw} color={amber} label="Migrates" value={meta.stats.migrates} />
      <StatRow Icon={Sparkles} color={violet} label="Singularities" value={meta.stats.singularities} />
      <StatRow Icon={Gamepad2} color={teal} label="Minigames won" value={meta.stats.minigamesWon} />
      <StatRow Icon={Gem} color={amber} label="Total wafers earned" value={meta.stats.totalWafersEarned} />
      <StatRow Icon={ListChecks} color={teal} label="Goals completed" value={`${completedCount}/${GOAL_DEFS.length}`} />
      {joined && <StatRow Icon={Calendar} color={textDim} label="Member since" value={joined} />}
    </div>
  );
}
