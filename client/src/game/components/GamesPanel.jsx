import { useState, useEffect } from 'react';
import { Zap, Bug, Cable, Flame } from 'lucide-react';
import { cardBg, cardBorder, textMain, textDim, amber, teal, violet, danger } from '../theme.js';

function GameCard({ Icon, iconColor, title, desc, btnColor, btnTextColor, onPlay, cooldownUntil, best, unit }) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!cooldownUntil || Date.now() >= cooldownUntil) return undefined;
    const iv = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, [cooldownUntil]);
  const remaining = cooldownUntil ? Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)) : 0;
  const onCooldown = remaining > 0;
  return (
    <div className="rounded-xl p-4" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
      <div className="flex items-center gap-2 mb-1">
        <Icon size={18} color={iconColor} />
        <div className="font-semibold text-sm" style={{ color: textMain }}>{title}</div>
      </div>
      <div className="text-xs mb-3" style={{ color: textDim }}>{desc}</div>
      {typeof best === 'number' && (
        <div className="text-xs font-mono mb-2" style={{ color: textDim }}>
          best {best} {unit}
        </div>
      )}
      <button
        onClick={onPlay}
        disabled={onCooldown}
        className="w-full rounded-lg py-2 text-sm font-semibold"
        style={{ background: onCooldown ? cardBg : btnColor, color: onCooldown ? textDim : btnTextColor, border: onCooldown ? `1px solid ${cardBorder}` : 'none', cursor: onCooldown ? 'not-allowed' : 'pointer' }}
      >
        {onCooldown ? `Cooldown ${remaining}s` : 'Play'}
      </button>
    </div>
  );
}

// `bests` is keyed by the same game strings the server stores in
// minigame_sessions.game (see MINIGAMES in server/routes/api.js), and is `{}`
// until GET /api/minigame/bests resolves - a card with no entry simply renders
// no best line rather than a zero, so a game never claims a score of 0.
export default function GamesPanel({ onStartRush, onStartDebug, onStartMatch, onStartBalance, cooldowns, minigamesConfig, bests = {} }) {
  const { rush, debug, match, balance } = minigamesConfig;
  return (
    <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3" data-tour="games-list">
      <GameCard Icon={Zap} iconColor={amber} title="Overclock Rush" desc={`Tap as fast as you can for ${rush.durationSec} seconds.`} btnColor={amber} btnTextColor="#0E141B" onPlay={onStartRush} cooldownUntil={cooldowns.rush} best={bests.rush} unit="taps" />
      <GameCard Icon={Bug} iconColor={teal} title="Debug Sprint" desc={`Squash the highlighted bugs before they hide - up to ${debug.maxLit} can appear at once. ${debug.durationSec} seconds.`} btnColor={teal} btnTextColor="#0E141B" onPlay={onStartDebug} cooldownUntil={cooldowns.debug} best={bests.debug} unit="squashed" />
      <GameCard Icon={Cable} iconColor={violet} title="Cable Match" desc={`Find all ${match.pairCount} matching pairs - the round ends the instant you finish. Only a full match pays out. ${match.durationSec} seconds.`} btnColor={violet} btnTextColor="#0E141B" onPlay={onStartMatch} cooldownUntil={cooldowns.match} best={bests.match} unit="pairs" />
      <GameCard Icon={Flame} iconColor={danger} title="Overclock Balance" desc={`Click the bar when the moving marker is in the safe zone. Clicking elsewhere costs you points. ${balance.durationSec} seconds.`} btnColor={danger} btnTextColor={textMain} onPlay={onStartBalance} cooldownUntil={cooldowns.balance} best={bests.balance} unit="points" />
    </div>
  );
}
