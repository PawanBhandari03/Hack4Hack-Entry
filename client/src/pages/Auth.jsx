import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, errorText } from '../api.js';
import { useApp } from '../appContext.js';
import SkillInput from '../components/SkillInput.jsx';
import { TIMEZONES } from '../lib/format.js';

const guessTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};


export default function Auth({ mode }) {
  const { user, login } = useApp();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', skills: [], timezone: guessTz() });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isRegister = mode === 'register';

  if (user) return <Navigate to="/" replace />;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = isRegister ? form : { email: form.email, password: form.password };
      const res = await api(`/api/auth/${isRegister ? 'register' : 'login'}`, { method: 'POST', body, retries: 0 });
      login(res.token, res.user);
      navigate('/');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const fillDemo = (n) => setForm((f) => ({ ...f, email: `demo${n}@hack4hack.dev`, password: 'password123' }));

  return (
    <main id="main" className="auth-wrap">
      <form className="card auth-card" onSubmit={submit} noValidate>
        <h1>{isRegister ? 'Create your account' : 'Welcome back'}</h1>
        <p className="muted">{isRegister ? 'Tell us your skills so teams can find you.' : 'Log in to find or build your team.'}</p>

        {isRegister && (
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" autoComplete="name" required minLength={2} value={form.name} onChange={set('name')} />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            required
            minLength={isRegister ? 8 : 1}
            value={form.password}
            onChange={set('password')}
          />
          {isRegister && <small className="muted">At least 8 characters.</small>}
        </div>
        {isRegister && (
          <>
            <SkillInput label="Skills" value={form.skills} onChange={(skills) => setForm((f) => ({ ...f, skills }))} />
            <div className="field">
              <label htmlFor="tz">Timezone</label>
              <select id="tz" value={form.timezone} onChange={set('timezone')}>
                {TIMEZONES.map((tz) => (
                  <option key={tz}>{tz}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Log in'}
        </button>

        {!isRegister && (
          <div className="demo-box">
            <span className="muted">Try a demo account:</span>
            {[1, 2, 3].map((n) => (
              <button key={n} type="button" className="btn btn-ghost btn-sm" onClick={() => fillDemo(n)}>
                demo{n}
              </button>
            ))}
          </div>
        )}
        <p className="muted center">
          {isRegister ? (
            <>
              Already have an account? <Link to="/login">Log in</Link>
            </>
          ) : (
            <>
              New here? <Link to="/register">Create an account</Link>
            </>
          )}
        </p>
      </form>
    </main>
  );
}
