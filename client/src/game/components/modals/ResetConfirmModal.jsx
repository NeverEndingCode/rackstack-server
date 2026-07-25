import { inset, cardBorder, textMain, textDim, danger } from '../../theme.js';

export default function ResetConfirmModal({ onCancel, onNext }) {
  return (
    <>
      <h2 className="text-lg font-bold mb-2">Reset everything?</h2>
      <p className="text-sm mb-4" style={{ color: textDim }}>Permanently deletes your save, including Legacy Cores, Shards, Wafers, Upgrades, Level, and Goals. No undo.</p>
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 rounded-lg py-2 text-sm" style={{ background: inset, color: textMain, border: `1px solid ${cardBorder}` }}>Cancel</button>
        <button onClick={onNext} className="flex-1 rounded-lg py-2 text-sm font-semibold" style={{ background: danger, color: textMain }}>Continue</button>
      </div>
    </>
  );
}
