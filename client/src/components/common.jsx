export function Chips({ items, highlight = [], variant = '', label = 'Skills' }) {
  if (!items?.length) return null;
  return (
    <ul className="chips" aria-label={label}>
      {items.map((s) => (
        <li key={s} className={`chip ${highlight.includes(s) ? 'chip-hl' : variant}`}>
          {s}
        </li>
      ))}
    </ul>
  );
}

export function Seats({ memberCount, maxSize, large = false }) {
  return (
    <span className={`seats ${large ? 'seats-lg' : ''}`} role="img" aria-label={`${memberCount} of ${maxSize} members`}>
      {Array.from({ length: maxSize }, (_, i) => (
        <span key={i} className={`seat ${i < memberCount ? 'seat-full' : ''}`} aria-hidden="true" />
      ))}
      <span className="seats-text" aria-hidden="true">
        {memberCount}/{maxSize}
      </span>
    </span>
  );
}

/** Team status stamp: full / ready / forming. */
export function TeamStamp({ team }) {
  if (team.openSeats === 0) return <span className="stamp stamp-red">Full</span>;
  if (!team.lookingForMembers) return <span className="stamp stamp-ink">Closed</span>;
  if (team.meetsMinimum) return <span className="stamp stamp-green">Ready</span>;
  return <span className="stamp stamp-amber">Forming</span>;
}

const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';

/** Monogram with a stable tint per name (no images needed, works offline). */
export function Avatar({ name, large = false }) {
  let h = 0;
  for (const c of name ?? '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className={`avatar ${large ? 'avatar-lg' : ''}`} style={{ background: `hsl(${h} 70% 85%)`, color: '#16150f' }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function Spinner({ label = 'Loading' }) {
  return (
    <div className="spinner" role="status">
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function Empty({ children }) {
  return <p className="empty">{children}</p>;
}
