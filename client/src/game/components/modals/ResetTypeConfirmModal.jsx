import { useState } from 'react';
import { inset, cardBorder, textMain, textDim, danger } from '../../theme.js';

const CONFIRM_WORD = 'RESET';

export default function ResetTypeConfirmModal({ onCancel, onConfirm }) {
  const [value, setValue] = useState('');
  const matches = value === CONFIRM_WORD;
  return (
    <>
      <h2 className="text-lg font-bold mb-2" style={{ color: danger }}>Final confirmation</h2>
      <p className="text-sm mb-3" style={{ color: textDim }}>
        Type <strong style={{ color: textMain }}>{CONFIRM_WORD}</strong> to permanently delete your save. This cannot be undone.
      </p>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
        className="w-full rounded-lg px-3 py-2 text-sm font-mono mb-4"
        style={{ background: inset, border: `1px solid ${cardBorder}`, color: textMain }}
        placeholder={CONFIRM_WORD}
      />
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 rounded-lg py-2 text-sm" style={{ background: inset, color: textMain, border: `1px solid ${cardBorder}` }}>Cancel</button>
        <button
          onClick={onConfirm}
          disabled={!matches}
          className="flex-1 rounded-lg py-2 text-sm font-semibold"
          style={{ background: matches ? danger : cardBorder, color: matches ? textMain : textDim, cursor: matches ? 'pointer' : 'not-allowed' }}
        >
          Delete save
        </button>
      </div>
    </>
  );
}
