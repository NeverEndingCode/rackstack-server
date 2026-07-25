import { AlertTriangle } from 'lucide-react';
import { amber, violet, danger, textDim, textMain } from '../../theme.js';
import { fmt } from '../../helpers.js';

export default function MessageModal({ modal, onClose }) {
  switch (modal.type) {
    case 'welcome':
      return (
        <>
          <h2 className="text-lg font-bold mb-2">Welcome back</h2>
          <p className="text-sm mb-4" style={{ color: textDim }}>Your automated racks, Grid, and Overclock Bay kept humming while you were away.</p>
          <div className="font-mono text-2xl mb-4" style={{ color: amber }}>+{fmt(modal.amount)} FLOPS</div>
          <button onClick={onClose} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: amber, color: '#0E141B' }}>Nice</button>
        </>
      );
    case 'eventClaim':
    case 'minigameResult':
      return (
        <>
          <h2 className="text-lg font-bold mb-2">Resolved</h2>
          <p className="text-sm mb-4" style={{ color: textDim }}>{modal.text}</p>
          <button onClick={onClose} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: amber, color: '#0E141B' }}>Nice</button>
        </>
      );
    case 'goalClaim':
      return (
        <>
          <h2 className="text-lg font-bold mb-2">Goal complete</h2>
          <p className="text-sm mb-4" style={{ color: textDim }}>+{modal.goal.xp} xp &middot; +{modal.goal.wafers} wafers</p>
          <button onClick={onClose} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: amber, color: '#0E141B' }}>Nice</button>
        </>
      );
    case 'levelUp':
      return (
        <>
          <h2 className="text-lg font-bold mb-2" style={{ color: violet }}>Level Up! &rarr; Lv {modal.level}</h2>
          <p className="text-sm mb-4" style={{ color: textDim }}>+{modal.goal.xp} xp &middot; +{modal.goal.wafers} wafers. Every level adds a small permanent output bonus.</p>
          <button onClick={onClose} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: violet, color: '#0E141B' }}>Nice</button>
        </>
      );
    case 'meltdown':
      return (
        <>
          <h2 className="text-lg font-bold mb-2 flex items-center gap-2" style={{ color: danger }}><AlertTriangle size={18} /> Thermal Meltdown!</h2>
          <p className="text-sm mb-4" style={{ color: textDim }}>Your Overclock Bay overheated and half your nodes were lost. The lane is frozen for a short cooldown. Keep an eye on the heat gauge and vent regularly, or invest in Thermal Regulators / Auto-Vent upgrades.</p>
          <button onClick={onClose} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: danger, color: textMain }}>Understood</button>
        </>
      );
    case 'singularityDone':
      return (
        <>
          <h2 className="text-lg font-bold mb-2" style={{ color: violet }}>Singularity achieved</h2>
          <p className="text-sm mb-4" style={{ color: textDim }}>+{modal.shards} Singularity Shards. Spend them in the Singularity tab for permanent perks.</p>
          <button onClick={onClose} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: violet, color: '#0E141B' }}>Nice</button>
        </>
      );
    default:
      return null;
  }
}
