import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../appContext.js';
import SkillInput from '../components/SkillInput.jsx';
import { Avatar, Chips } from '../components/common.jsx';
import { TIMEZONES, tzLabel } from '../lib/format.js';

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
    <main id="main" className="page wrap">
      <div className="split">
        <form className="panel accent stack-sm" onSubmit={save}>
          <p className="kicker">Your listing</p>
          <h1 style={{ fontSize: 'clamp(1.8rem, 4vw, 2.4rem)' }}>Your profile</h1>
          <p className="muted">Skills and timezone power teammate suggestions and your card in the classifieds.</p>
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
            <span className="hint">{280 - form.bio.length} characters left</span>
          </div>
          <div style={{ paddingTop: 8 }}>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </form>

        <aside className="sidebar" aria-labelledby="preview-h">
          <p className="kicker" id="preview-h">
            Preview: how teams see you
          </p>
          <div className="ad">
            <div className="ad-top">
              <span className="kicker">Seeking a team</span>
              <span className="stamp stamp-green">Available</span>
            </div>
            <div className="person-head">
              <Avatar name={form.name} />
              <div className="grow">
                <h3 style={{ margin: 0 }}>{form.name || 'Your name'}</h3>
                <span className="tz">{tzLabel(form.timezone)}</span>
              </div>
            </div>
            {form.bio && <p className="ad-body">{form.bio}</p>}
            <div className="ad-foot">{form.skills.length ? <Chips items={form.skills} /> : <span className="hint">Add skills so teams can find you.</span>}</div>
          </div>
        </aside>
      </div>
    </main>
  );
}
