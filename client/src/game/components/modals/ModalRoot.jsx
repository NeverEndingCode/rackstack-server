import { cardBg, cardBorder } from '../../theme.js';
import MessageModal from './MessageModal.jsx';
import MigrateConfirmModal from './MigrateConfirmModal.jsx';
import SingularityConfirmModal from './SingularityConfirmModal.jsx';
import ResetConfirmModal from './ResetConfirmModal.jsx';
import ResetTypeConfirmModal from './ResetTypeConfirmModal.jsx';

const NON_DISMISSIBLE = ['migrate', 'reset', 'resetConfirmType', 'singularity'];
const MESSAGE_TYPES = ['welcome', 'eventClaim', 'minigameResult', 'goalClaim', 'levelUp', 'singularityDone', 'meltdown'];

export default function ModalRoot({ modal, setModal, meta, gain, singularityGain, onMigrate, onSingularity, onHardReset }) {
  if (!modal) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={() => { if (!NON_DISMISSIBLE.includes(modal.type)) setModal(null); }}
    >
      <div className="rounded-xl p-5 max-w-sm w-full" style={{ background: cardBg, border: `1px solid ${cardBorder}` }} onClick={(e) => e.stopPropagation()}>
        {MESSAGE_TYPES.includes(modal.type) && <MessageModal modal={modal} onClose={() => setModal(null)} />}
        {modal.type === 'migrate' && <MigrateConfirmModal gain={gain} onCancel={() => setModal(null)} onConfirm={onMigrate} />}
        {modal.type === 'singularity' && <SingularityConfirmModal legacyCores={meta.legacyCores} singularityGain={singularityGain} onCancel={() => setModal(null)} onConfirm={onSingularity} />}
        {modal.type === 'reset' && <ResetConfirmModal onCancel={() => setModal(null)} onNext={() => setModal({ type: 'resetConfirmType' })} />}
        {modal.type === 'resetConfirmType' && <ResetTypeConfirmModal onCancel={() => setModal(null)} onConfirm={onHardReset} />}
      </div>
    </div>
  );
}
