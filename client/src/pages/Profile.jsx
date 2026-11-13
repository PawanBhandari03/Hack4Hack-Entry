import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../appContext.js';
import SkillInput from '../components/SkillInput.jsx';
import { TIMEZONES } from '../lib/format.js';


export default function Profile() {
  const { user, setUser, refreshMine, toast, toastError } = useApp();
  const [form, setForm] = useState({ name: user.name, skills: user.skills, timezone: user.timezone, bio: user.bio ?? '' });
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api('/api/auth/me', { method: 'PATCH', body: form });
      setUser(res.user);
      refreshMine();
      toast('Profile saved', 'success');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" className="container narrow">
      <form className="card stack" onSubmit={save}>
        <h1>Your profile</h1>
        <p className="muted">Skills and timezone power teammate suggestions.</p>
        <div className="field">
          <label htmlFor="pname">Name</label>
          <input id="pname" value={form.name} minLength={2} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="pemail">Email</label>
          <input id="pemail" value={user.email} disabled />
        </div>
        <SkillInput label="Skills" value={form.skills} onChange={(skills) => setForm({ ...form, skills })} />
        <div className="field">
          <label htmlFor="ptz">Timezone</label>
          <select id="ptz" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            {TIMEZONES.map((tz) => (
              <option key={tz}>{tz}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pbio">Short bio</label>
          <textarea id="pbio" rows={3} maxLength={280} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save profile'}
        </button>
      </form>
    </main>
  );
}
