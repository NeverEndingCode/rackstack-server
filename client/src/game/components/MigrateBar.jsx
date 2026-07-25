import { RefreshCw } from 'lucide-react';
import { amber, cardBg, inset, cardBorder, textDim, textMain } from '../theme.js';

export default function MigrateBar({ gain, anyReady, onMigrate, onCollectAll }) {
  return (
    <div className="mt-3 flex gap-2">
      <button
        onClick={onMigrate}
        disabled={gain <= 0}
        className="flex-1 rounded-lg py-2 text-sm font-semibold tracking-wide flex items-center justify-center gap-2"
        style={{ background: gain > 0 ? amber : cardBg, color: gain > 0 ? '#0E141B' : textDim, cursor: gain > 0 ? 'pointer' : 'not-allowed' }}
      >
        <RefreshCw size={16} /> Migrate{gain > 0 ? ` (+${gain} cores)` : ''}
      </button>
      {anyReady && (
        <button onClick={onCollectAll} className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: inset, border: `1px solid ${cardBorder}`, color: textMain }}>
          Collect All
        </button>
      )}
    </div>
  );
}
