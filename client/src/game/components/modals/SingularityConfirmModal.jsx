import { inset, cardBorder, textMain, textDim, violet } from '../../theme.js';
import { fmtCores } from '../../helpers.js';
import { useCoreFormat } from '../../coreFormat.js';

export default function SingularityConfirmModal({ legacyCores, singularityGain, onCancel, onConfirm }) {
  const coreFormat = useCoreFormat();
  return (
    <>
      <h2 className="text-lg font-bold mb-2" style={{ color: violet }}>Trigger Singularity?</h2>
      <p className="text-sm mb-4" style={{ color: textDim }}>Converts {fmtCores(legacyCores, coreFormat)} Legacy Cores into +{singularityGain} Singularity Shards. Your run AND Legacy Cores reset to zero.</p>
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 rounded-lg py-2 text-sm" style={{ background: inset, color: textMain, border: `1px solid ${cardBorder}` }}>Cancel</button>
        <button onClick={onConfirm} className="flex-1 rounded-lg py-2 text-sm font-semibold" style={{ background: violet, color: '#0E141B' }}>Trigger</button>
      </div>
    </>
  );
}
