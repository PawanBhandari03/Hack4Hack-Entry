export function Chips({ items, highlight = [] }) {
  if (!items?.length) return null;
  return (
    <ul className="chips" aria-label="Skills">
      {items.map((s) => (
        <li key={s} className={`chip ${highlight.includes(s) ? 'chip-hl' : ''}`}>
          {s}
        </li>
      ))}
    </ul>
  );
}

export function Seats({ memberCount, maxSize }) {
  return (
    <span className="seats" aria-label={`${memberCount} of ${maxSize} members`}>
      {Array.from({ length: maxSize }, (_, i) => (
        <span key={i} className={`seat ${i < memberCount ? 'seat-full' : ''}`} aria-hidden="true" />
      ))}
      <span className="seats-text">
        {memberCount}/{maxSize}
      </span>
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

export const tzLabel = (tz) => {
  try {
    const off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    return `${tz.split('/').pop().replace(/_/g, ' ')} (${off})`;
  } catch {
    return tz;
  }
};

/** All IANA timezones the browser knows, always including UTC (some browsers omit it). */
export const TIMEZONES = (() => {
  let list = [];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch {
    list = ['Asia/Kolkata', 'Europe/London', 'America/New_York'];
  }
  return list.includes('UTC') ? list : ['UTC', ...list];
})();
