import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../state.jsx';
import SkillInput from '../components/SkillInput.jsx';
import { Chips, Seats, Spinner, Empty, tzLabel } from '../components/common.jsx';

/* ------------------------------------------------------------------ */
/* Live list: fetch a page over REST, then apply WebSocket updates.    */
/* ------------------------------------------------------------------ */
function useLiveBoard(kind, hackathonId, skill) {
  const { socket } = useApp();
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState({});
  const reqId = useRef(0);

  const load = useCallback(
    async (after) => {
      const id = ++reqId.current;
      setLoading(true);
      const qs = new URLSearchParams({ limit: '20' });
      if (skill) qs.set('skill', skill);
      if (after) qs.set('cursor', after);
      try {
        const res = await api(`/api/hackathons/${hackathonId}/board/${kind}?${qs}`);
        if (id !== reqId.current) return; // a newer request superseded this one
        setItems((prev) => (after ? [...prev, ...res.items.filter((i) => !prev.some((p) => key(p) === key(i)))] : res.items));
        setCursor(res.nextCursor);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [hackathonId, kind, skill]
  );

  useEffect(() => {
    load(null);
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const matchesSkill = (list) => !skill || list.includes(skill);
    const ping = (k) => {
      setFlash((f) => ({ ...f, [k]: Date.now() }));
      setTimeout(() => setFlash((f) => ({ ...f, [k]: 0 })), 1200);
    };
    const upsert = (item, keep) =>
      setItems((prev) => {
        const rest = prev.filter((p) => key(p) !== key(item));
        return keep ? [item, ...rest] : rest;
      });

    const onTeam = (t) => {
      if (kind !== 'teams') return;
      upsert(t, t.openSeats > 0 && t.lookingForMembers && matchesSkill(t.skillsWanted));
      ping(t.id);
    };
    const onTeamRemoved = ({ teamId }) => kind === 'teams' && setItems((prev) => prev.filter((p) => p.id !== teamId));
    const onPerson = (p) => {
      if (kind !== 'people') return;
      upsert(p, !p.teamId && p.lookingForTeam && matchesSkill(p.skills));
      ping(p.userId);
    };
    const subscribe = () => socket.emit('board:subscribe', hackathonId);
    const resync = () => load(null);

    subscribe();
    socket.on('connect', subscribe);
    socket.on('connect', resync); // missed events while offline -> refetch
    socket.on('board:team', onTeam);
    socket.on('board:team-removed', onTeamRemoved);
    socket.on('board:person', onPerson);
    return () => {
      socket.emit('board:unsubscribe', hackathonId);
      socket.off('connect', subscribe);
      socket.off('connect', resync);
      socket.off('board:team', onTeam);
      socket.off('board:team-removed', onTeamRemoved);
      socket.off('board:person', onPerson);
    };
  }, [socket, hackathonId, kind, skill, load]);

  return { items, loading, hasMore: Boolean(cursor), loadMore: () => load(cursor), flash };
}

const key = (i) => i.id ?? i.userId;

/* ------------------------------------------------------------------ */

function MyStatus() {
  const { hackathon, mine, refreshMine, toast, toastError } = useApp();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [team, setTeam] = useState({ name: '', description: '', skillsWanted: [] });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  if (!mine) return <Spinner />;

  if (mine.team) {
    const t = mine.team;
    return (
      <section className="card status-card" aria-labelledby="my-team-h">
        <div>
          <p className="eyebrow">Your team</p>
          <h2 id="my-team-h">{t.name}</h2>
          <p className="muted">
            {mine.me.role === 'leader' ? 'You are the leader.' : 'You are a member.'}{' '}
            {t.meetsMinimum ? 'Team meets the minimum size.' : `Needs ${t.minSize - t.memberCount} more to reach the minimum.`}
          </p>
        </div>
        <div className="status-actions">
          <Seats memberCount={t.memberCount} maxSize={t.maxSize} />
          <Link className="btn btn-primary" to={`/teams/${t.id}`}>
            Open team page
          </Link>
        </div>
      </section>
    );
  }

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api(`/api/hackathons/${hackathon.id}/teams`, { method: 'POST', body: team });
      toast(`Team "${res.team.name}" created`, 'success');
      await refreshMine();
      navigate(`/teams/${res.team.id}`);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const redeem = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api('/api/invites/redeem', { method: 'POST', body: { code } });
      toast(`You joined ${res.team.name}!`, 'success');
      await refreshMine();
      navigate(`/teams/${res.team.id}`);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const toggleLooking = async () => {
    try {
      await api(`/api/hackathons/${hackathon.id}/me`, { method: 'PATCH', body: { lookingForTeam: !mine.me.lookingForTeam } });
      await refreshMine();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <section className="card status-card stack" aria-labelledby="no-team-h">
      <div className="row-between">
        <div>
          <p className="eyebrow">You're not in a team yet</p>
          <h2 id="no-team-h">Find your people</h2>
        </div>
        <label className="switch">
          <input type="checkbox" checked={mine.me.lookingForTeam} onChange={toggleLooking} />
          <span>Show me on the board</span>
        </label>
      </div>

      <div className="grid-2">
        <form onSubmit={redeem} className="inline-form" aria-label="Join with invite code">
          <label htmlFor="code">Have an invite code?</label>
          <div className="row">
            <input
              id="code"
              placeholder="ABCDE-12345"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              spellCheck="false"
              className="mono"
            />
            <button className="btn btn-primary" disabled={busy || code.trim().length < 10}>
              Join
            </button>
          </div>
        </form>
        <div className="inline-form">
          <span className="label-like">Or start your own</span>
          <button className="btn" aria-expanded={showCreate} aria-controls="create-form" onClick={() => setShowCreate((s) => !s)}>
            {showCreate ? 'Cancel' : 'Create a team'}
          </button>
        </div>
      </div>

      {showCreate && (
        <form id="create-form" onSubmit={create} className="stack">
          <div className="field">
            <label htmlFor="tname">Team name</label>
            <input id="tname" required minLength={2} maxLength={50} value={team.name} onChange={(e) => setTeam({ ...team, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="tdesc">What are you building?</label>
            <textarea id="tdesc" rows={2} maxLength={500} value={team.description} onChange={(e) => setTeam({ ...team, description: e.target.value })} />
          </div>
          <SkillInput label="Skills you're looking for" value={team.skillsWanted} onChange={(skillsWanted) => setTeam({ ...team, skillsWanted })} />
          <button className="btn btn-primary" disabled={busy || team.name.trim().length < 2}>
            {busy ? 'Creating…' : 'Create team'}
          </button>
        </form>
      )}

      {mine.pendingRequests?.length > 0 && (
        <div>
          <h3 className="h-sm">Your pending requests</h3>
          <ul className="list">
            {mine.pendingRequests.map((r) => (
              <li key={r.id} className="row-between list-row">
                <Link to={`/teams/${r.teamId}`}>{r.teamName}</Link>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    try {
                      await api(`/api/requests/${r.id}/cancel`, { method: 'POST' });
                      refreshMine();
                    } catch (err) {
                      toastError(err);
                    }
                  }}
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Suggestions() {
  const { hackathon, mine } = useApp();
  const [data, setData] = useState(null);
  const teamId = mine?.team?.id;

  useEffect(() => {
    if (!mine) return;
    api(`/api/hackathons/${hackathon.id}/suggestions`).then(setData).catch(() => setData(null));
  }, [hackathon.id, mine, teamId]);

  if (!data?.items?.length) return null;
  return (
    <section className="card" aria-labelledby="sugg-h">
      <h2 id="sugg-h" className="h-sm">
        {data.mode === 'people' ? 'Suggested teammates' : 'Teams that need your skills'}
      </h2>
      <p className="muted small">
        Score = {Math.round(data.weights.skills * 100)}% complementary skills + {Math.round(data.weights.timezone * 100)}% timezone overlap
        {data.neededSkills?.length ? ` · Your team still needs: ${data.neededSkills.join(', ')}` : ''}
      </p>
      <ol className="sugg-list">
        {data.items.slice(0, 5).map((s) => {
          const label = s.person ? s.person.name : s.team.name;
          const href = s.team ? `/teams/${s.team.id}` : null;
          return (
            <li key={s.person?.userId ?? s.team.id} className="sugg">
              <span className="score" aria-label={`Match score ${s.score} out of 100`}>
                {s.score}
              </span>
              <div className="grow">
                {href ? <Link to={href}>{label}</Link> : <strong>{label}</strong>}
                <div className="muted small">
                  {s.breakdown.matchedSkills.length ? `brings ${s.breakdown.matchedSkills.join(', ')}` : 'no missing skills covered'} ·{' '}
                  {s.breakdown.hoursApart}h apart
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TeamCard({ t, flash, canRequest }) {
  const { toastError, toast } = useApp();
  const [requested, setRequested] = useState(false);

  // Optimistic UI: show "Requested" instantly, roll back if the server says no.
  const request = async () => {
    setRequested(true);
    try {
      await api(`/api/teams/${t.id}/requests`, { method: 'POST', body: {} });
      toast(`Request sent to ${t.name}`, 'success');
    } catch (err) {
      setRequested(false);
      toastError(err);
    }
  };

  return (
    <li className={`card item ${flash ? 'flash' : ''}`}>
      <div className="row-between">
        <h3 className="item-title">
          <Link to={`/teams/${t.id}`}>{t.name}</Link>
        </h3>
        <Seats memberCount={t.memberCount} maxSize={t.maxSize} />
      </div>
      {t.description && <p className="muted clamp">{t.description}</p>}
      {t.skillsWanted.length > 0 && (
        <div className="row small">
          <span className="muted">Looking for</span>
          <Chips items={t.skillsWanted} />
        </div>
      )}
      {canRequest && (
        <button className="btn btn-sm" onClick={request} disabled={requested} aria-label={`Request to join ${t.name}`}>
          {requested ? 'Requested ✓' : 'Request to join'}
        </button>
      )}
    </li>
  );
}

function PersonCard({ p, flash }) {
  return (
    <li className={`card item ${flash ? 'flash' : ''}`}>
      <div className="row-between">
        <h3 className="item-title">{p.name}</h3>
        <span className="muted small">{tzLabel(p.timezone)}</span>
      </div>
      <Chips items={p.skills} />
    </li>
  );
}

export default function Board() {
  const { hackathon } = useApp();
  if (!hackathon) return <main id="main" className="container"><Empty>No hackathon found. Is the API running?</Empty></main>;
  return <BoardInner hackathon={hackathon} />;
}

function BoardInner({ hackathon }) {
  const { mine } = useApp();
  const [tab, setTab] = useState('teams');
  const [skill, setSkill] = useState('');
  const [skillInput, setSkillInput] = useState('');
  const board = useLiveBoard(tab, hackathon.id, skill);
  const canRequest = mine && !mine.team;

  const tabs = [
    { id: 'teams', label: 'Teams with open seats' },
    { id: 'people', label: 'People looking for a team' },
  ];

  return (
    <main id="main" className="container stack">
      <div>
        <h1>{hackathon.name}</h1>
        <p className="muted">
          Teams of {hackathon.minTeamSize}–{hackathon.maxTeamSize}. Everything on this page updates live.
        </p>
      </div>

      <MyStatus />
      <Suggestions />

      <section aria-labelledby="board-h" className="stack">
        <h2 id="board-h" className="sr-only">
          Looking for teammates board
        </h2>
        <div className="row-between wrap">
          <div role="tablist" aria-label="Board" className="tabs">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="board-panel"
                tabIndex={tab === t.id ? 0 : -1}
                className={`tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    const next = tabs[(tabs.findIndex((x) => x.id === tab) + 1) % tabs.length].id;
                    setTab(next);
                    document.getElementById(`tab-${next}`)?.focus();
                  }
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <form
            className="row"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              setSkill(skillInput.trim().toLowerCase());
            }}
          >
            <label htmlFor="skill-filter" className="sr-only">
              Filter by skill
            </label>
            <input id="skill-filter" placeholder="Filter by skill, e.g. react" value={skillInput} onChange={(e) => setSkillInput(e.target.value)} />
            <button className="btn">Filter</button>
            {skill && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setSkill('');
                  setSkillInput('');
                }}
              >
                Clear
              </button>
            )}
          </form>
        </div>

        <div id="board-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} aria-busy={board.loading}>
          {!board.loading && board.items.length === 0 && <Empty>Nothing here yet.</Empty>}
          <ul className="grid-cards">
            {board.items.map((i) =>
              tab === 'teams' ? (
                <TeamCard key={i.id} t={i} flash={board.flash[i.id]} canRequest={canRequest} />
              ) : (
                <PersonCard key={i.userId} p={i} flash={board.flash[i.userId]} />
              )
            )}
          </ul>
          {board.loading && <Spinner />}
          {board.hasMore && !board.loading && (
            <div className="center">
              <button className="btn" onClick={board.loadMore}>
                Load more
              </button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
