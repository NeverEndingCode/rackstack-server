import { RefreshCw } from 'lucide-react';
import { amber, cardBg, inset, cardBorder, textDim, textMain } from '../theme.js';
import { fmtCores } from '../helpers.js';
import { useCoreFormat } from '../coreFormat.js';

export default function MigrateBar({ gain, showCollectAll, collectDisabled, onMigrate, onCollectAll }) {
  const coreFormat = useCoreFormat();
  return (
    <div className="mt-3 flex gap-2" data-tour="migrate-bar">
      <button
        onClick={onMigrate}
        disabled={gain <= 0}
        className="flex-1 rounded-lg py-2 text-sm font-semibold tracking-wide flex items-center justify-center gap-2"
        style={{ background: gain > 0 ? amber : cardBg, color: gain > 0 ? '#0E141B' : textDim, cursor: gain > 0 ? 'pointer' : 'not-allowed' }}
      >
        <RefreshCw size={16} /> Migrate{gain > 0 ? ` (+${fmtCores(gain, coreFormat)} cores)` : ''}
      </button>
      {showCollectAll && (
        <button
          onClick={onCollectAll}
          disabled={collectDisabled}
          className="rounded-lg px-4 py-2 text-sm font-semibold"
          style={{
            background: collectDisabled ? cardBg : inset,
            border: `1px solid ${cardBorder}`,
            color: collectDisabled ? textDim : textMain,
            opacity: collectDisabled ? 0.55 : 1,
            cursor: collectDisabled ? 'not-allowed' : 'pointer',
          }}
        >
          Collect All
        </button>
      )}
    </div>
  );
}
