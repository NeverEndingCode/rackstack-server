import { UserCircle } from 'lucide-react';
import { inset, cardBorder, textDim, violet } from '../theme.js';

export default function HeaderBar({ user, displayName, level, onOpenProfile }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-xl font-bold tracking-widest" style={{ color: '#EDEDE3' }}>RACKSTACK</h1>
        <p className="text-xs tracking-wide" style={{ color: textDim }}>spare pi to hyperscale</p>
      </div>
      <div className="flex items-center gap-2">
        {user && (
          <button onClick={onOpenProfile} className="flex items-center gap-1.5" title="View profile">
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="w-6 h-6 rounded-full" style={{ border: `1px solid ${cardBorder}` }} />
            ) : (
              <UserCircle size={22} color={textDim} />
            )}
            <span className="text-xs font-mono truncate max-w-[160px]" style={{ color: textDim }}>{displayName || user.username}</span>
          </button>
        )}
        <div className="rounded-lg px-2 py-1 text-xs font-mono" style={{ background: inset, border: `1px solid ${cardBorder}`, color: violet }}>Lv {level}</div>
      </div>
    </div>
  );
}
