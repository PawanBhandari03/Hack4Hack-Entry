import { useId, useState } from 'react';

/** Tag-style skill input. Enter or comma adds a skill; Backspace on empty input removes the last one. */
export default function SkillInput({ label, value, onChange, max = 15, placeholder = 'Type a skill, press Enter' }) {
  const [draft, setDraft] = useState('');
  const id = useId();

  const add = (raw) => {
    const s = raw.trim().toLowerCase();
    if (!s || value.includes(s) || value.length >= max) return;
    onChange([...value, s]);
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="skill-input">
        {value.map((s) => (
          <span key={s} className="chip">
            {s}
            <button type="button" className="chip-x" aria-label={`Remove ${s}`} onClick={() => onChange(value.filter((x) => x !== s))}>
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
              setDraft('');
            } else if (e.key === 'Backspace' && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => {
            add(draft);
            setDraft('');
          }}
        />
      </div>
    </div>
  );
}
