import { inset, cardBorder, textMain, textDim, amber, teal } from '../../theme.js';

export default function MigrateConfirmModal({ gain, onCancel, onConfirm }) {
  return (
    <>
      <h2 className="text-lg font-bold mb-2">Migrate to a new facility?</h2>
      <p className="text-sm mb-4" style={{ color: textDim }}>Wipes your current Racks, Grid, Overclock Bay, and balance, converts everything you've produced into Legacy Cores &mdash; a permanent +5% output boost each, forever. Wafers, Upgrades, Level, and Goals are unaffected.</p>
      <div className="font-mono text-xl mb-4" style={{ color: teal }}>+{gain} Legacy Cores</div>
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 rounded-lg py-2 text-sm" style={{ background: inset, color: textMain, border: `1px solid ${cardBorder}` }}>Cancel</button>
        <button onClick={onConfirm} className="flex-1 rounded-lg py-2 text-sm font-semibold" style={{ background: amber, color: '#0E141B' }}>Migrate</button>
      </div>
    </>
  );
}
