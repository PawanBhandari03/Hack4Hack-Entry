import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../appContext.js';
import SkillInput from '../components/SkillInput.jsx';
import { Avatar, Chips, Seats, Spinner, Empty, TeamStamp } from '../components/common.jsx';
import { tzLabel } from '../lib/format.js';

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
      const qs = new URLSearchParams({ limit: '24' });
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
    // oxlint-disable-next-line react/set-state-in-effect -- (re)fetch when tab/skill changes
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
    // The hackathon room subscription lives in state.jsx (app-wide), so team pages get updates too.
    const resync = () => load(null);

    socket.on('connect', resync); // missed events while offline -> refetch
    socket.on('board:team', onTeam);
    socket.on('board:team-removed', onTeamRemoved);
    socket.on('board:person', onPerson);
    return () => {
      socket.off('connect', resync);
      socket.off('board:team', onTeam);
      socket.off('board:team-removed', onTeamRemoved);
      socket.off('board:person', onPerson);
    };
  }, [socket, hackathonId, kind, skill, load]);

  return { items, loading, hasMore: Boolean(cursor), loadMore: () => load(cursor), flash };
}

const key = (i) => i.id ?? i.userId;

/** Headline numbers. Refetched (at most every 2 s) whenever the board changes. */
function useStats(hackathonId) {
  const { socket } = useApp();
  const [stats, setStats] = useState(null);
  useEffect(() => {
    let timer = null;
    let alive = true;
    const load = () =>
      api(`/api/hackathons/${hackathonId}/stats`)
        .then((s) => alive && setStats(s))
        .catch(() => {});
    const soon = () => {
      if (!timer) timer = setTimeout(() => ((timer = null), load()), 2000);
    };
    load();
    socket?.on('board:team', soon);
    socket?.on('board:team-removed', soon);
    socket?.on('board:person', soon);
    return () => {
      alive = false;
      clearTimeout(timer);
      socket?.off('board:team', soon);
      socket?.off('board:team-removed', soon);
      socket?.off('board:person', soon);
    };
  }, [hackathonId, socket]);
  return stats;
}

const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-US'));

/** Countdown to the team-formation deadline. The server enforces it; this just shows it. */
function Deadline({ closesAt }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!closesAt) return null;
  const ms = new Date(closesAt).getTime() - now;
  if (ms <= 0) return <p className="badge badge-danger">Team formation has closed</p>;
  const parts = [
    [Math.floor(ms / 86_400_000), 'days'],
    [Math.floor((ms % 86_400_000) / 3_600_000), 'hours'],
    [Math.floor((ms % 3_600_000) / 60_000), 'mins'],
  ];
  return (
    <div>
      <p className="kicker plain" id="deadline-h">
        Team formation closes in
      </p>
      <div className="countdown" role="timer" aria-labelledby="deadline-h">
        {parts.map(([v, unit]) => (
          <span key={unit}>
            <b>{String(v).padStart(2, '0')}</b>
            <small>{unit}</small>
          </span>
        ))}
      </div>
      <p className="tz">
        <time dateTime={new Date(closesAt).toISOString()}>{new Date(closesAt).toLocaleString()}</time>
      </p>
    </div>
  );
}

function MostWanted({ stats, skill, onPick }) {
  const list = stats?.mostWantedSkills ?? [];
  const max = Math.max(1, ...list.map((s) => s.teams));
  return (
    <section aria-labelledby="wanted-h">
      <p className="kicker" id="wanted-h">
        Most wanted skills
      </p>
      <p className="small muted">Open teams asking for each skill. Tap one to filter the classifieds.</p>
      {!stats ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty>No open teams yet.</Empty>
      ) : (
        <ul className="bars">
          {list.map((s) => (
            <li key={s.skill}>
              <button type="button" aria-pressed={skill === s.skill} onClick={() => onPick(skill === s.skill ? '' : s.skill)}>
                <span className="bar-label">{s.skill}</span>
                <span className="bar-track" aria-hidden="true">
                  <span className="bar-fill" style={{ width: `${(s.teams / max) * 100}%` }} />
                </span>
                <span className="bar-num">
                  {fmt(s.teams)}
                  <span className="sr-only"> teams</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatsStrip({ stats }) {
  const pctInTeams = stats?.participants ? Math.round((stats.inTeams / stats.participants) * 100) : null;
  const items = [
    { big: fmt(stats?.recruitingTeams), label: 'Teams recruiting', sub: stats ? `of ${fmt(stats.teams)} teams` : '' },
    { big: fmt(stats?.openSeats), label: 'Open seats', sub: stats ? `${fmt(stats.fullTeams)} teams full` : '' },
    { big: fmt(stats?.lookingForTeam), label: 'People looking', sub: stats ? `${fmt(stats.solo)} without a team` : '' },
    { big: pctInTeams == null ? '—' : `${pctInTeams}%`, label: 'Already in a team', sub: stats ? `${fmt(stats.inTeams)} of ${fmt(stats.participants)}` : '' },
  ];
  return (
    <ul className="stats" aria-label="Hackathon at a glance">
      {items.map((s) => (
        <li key={s.label} className="stat">
          <span className="big">{s.big}</span>
          <span className="label">{s.label}</span>
          <span className="sub">{s.sub}</span>
        </li>
      ))}
    </ul>
  );
}

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
      <section className="panel accent" aria-labelledby="my-team-h">
        <div className="row-between">
          <p className="kicker">Your team</p>
          <TeamStamp team={t} />
        </div>
        <h2 id="my-team-h">{t.name}</h2>
        <p className="muted">
          {mine.me.role === 'leader' ? 'You lead this team.' : 'You are a member.'}{' '}
          {t.meetsMinimum ? 'It meets the minimum size.' : `It needs ${t.minSize - t.memberCount} more to reach the minimum.`}
        </p>
        <div className="row-between" style={{ marginTop: 16 }}>
          <Seats memberCount={t.memberCount} maxSize={t.maxSize} large />
          <Link className="btn btn-primary" to={`/teams/${t.id}`}>
            Open team page →
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
    <section className="panel accent stack" aria-labelledby="no-team-h">
      <div className="row-between">
        <div>
          <p className="kicker">You're not in a team yet</p>
          <h2 id="no-team-h" style={{ margin: 0 }}>
            Find your people
          </h2>
        </div>
        <label className="switch">
          <input type="checkbox" checked={mine.me.lookingForTeam} onChange={toggleLooking} />
          <span>List me in the classifieds</span>
        </label>
      </div>

      <form onSubmit={redeem} className="field" aria-label="Join with invite code">
        <label htmlFor="code">Have an invite code?</label>
        <div className="input-row">
          <input
            id="code"
            placeholder="ABCDE-12345"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            spellCheck="false"
            className="code-input"
          />
          <button className="btn btn-primary" disabled={busy || code.trim().length < 10}>
            Join
          </button>
        </div>
        <span className="hint">Codes join you instantly. No approval needed.</span>
      </form>

      <p className="or-rule">or</p>

      <div className="row-between">
        <span className="small muted">Start your own team and recruit from the board.</span>
        <button className="btn btn-ghost" aria-expanded={showCreate} aria-controls="create-form" onClick={() => setShowCreate((s) => !s)}>
          {showCreate ? 'Cancel' : 'Create a team'}
        </button>
      </div>

      {showCreate && (
        <form id="create-form" onSubmit={create} className="stack-sm">
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
          <p className="kicker plain">Your pending requests</p>
          <ul className="list">
            {mine.pendingRequests.map((r) => (
              <li key={r.id} className="row-between">
                <Link to={`/teams/${r.teamId}`}>{r.teamName}</Link>
                <button
                  className="btn btn-text"
                  onClick={async () => {
                    try {
                      await api(`/api/requests/${r.id}/cancel`, { method: 'POST' });
                      refreshMine();
                    } catch (err) {
                      toastError(err);
                    }
                  }}
                >
                  Cancel request
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
    <section className="panel" aria-labelledby="sugg-h">
      <p className="kicker">Matchmaker</p>
      <h2 id="sugg-h" className="panel-title">
        {data.mode === 'people' ? 'Suggested teammates' : 'Teams that need you'}
      </h2>
      <p className="formula">
        score = {Math.round(data.weights.skills * 100)}% skills they need + {Math.round(data.weights.timezone * 100)}% timezone overlap
        {data.neededSkills?.length ? ` · still needed: ${data.neededSkills.join(', ')}` : ''}
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
                {href ? (
                  <Link to={href}>
                    <strong>{label}</strong>
                  </Link>
                ) : (
                  <strong>{label}</strong>
                )}
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
    <li className={`ad ${flash ? 'flash' : ''}`}>
      <div className="ad-top">
        <span className="kicker">
          Wanted · {t.openSeats} seat{t.openSeats === 1 ? '' : 's'}
        </span>
        <TeamStamp team={t} />
      </div>
      <h3>
        <Link to={`/teams/${t.id}`}>{t.name}</Link>
      </h3>
      {t.description && <p className="ad-body clamp">{t.description}</p>}
      {t.skillsWanted.length > 0 && (
        <div>
          <p className="ad-label">Looking for</p>
          <Chips items={t.skillsWanted} variant="chip-want" label="Skills wanted" />
        </div>
      )}
      <div className="ad-foot">
        <Seats memberCount={t.memberCount} maxSize={t.maxSize} />
        {canRequest && (
          <button className="btn btn-sm" onClick={request} disabled={requested} aria-label={`Request to join ${t.name}`}>
            {requested ? 'Requested ✓' : 'Request to join'}
          </button>
        )}
      </div>
    </li>
  );
}

function PersonCard({ p, flash }) {
  return (
    <li className={`ad ${flash ? 'flash' : ''}`}>
      <div className="ad-top">
        <span className="kicker">Seeking a team</span>
        <span className="stamp stamp-green">Available</span>
      </div>
      <div className="person-head">
        <Avatar name={p.name} />
        <div className="grow">
          <h3>{p.name}</h3>
          <span className="tz">{tzLabel(p.timezone)}</span>
        </div>
      </div>
      {p.bio && <p className="ad-body clamp clamp-2">{p.bio}</p>}
      <div className="ad-foot">
        <Chips items={p.skills} />
      </div>
    </li>
  );
}

export default function Board() {
  const { hackathon } = useApp();
  if (!hackathon)
    return (
      <main id="main" className="page wrap">
        <Empty>No hackathon found. Is the API running?</Empty>
      </main>
    );
  return <BoardInner hackathon={hackathon} />;
}

function BoardInner({ hackathon }) {
  const { mine } = useApp();
  const [tab, setTab] = useState('teams');
  const [skill, setSkill] = useState('');
  const [skillInput, setSkillInput] = useState('');
  const board = useLiveBoard(tab, hackathon.id, skill);
  const stats = useStats(hackathon.id);
  const canRequest = mine && !mine.team;

  const pickSkill = (s) => {
    setSkill(s);
    setSkillInput(s);
    setTab('teams');
    document.getElementById('classifieds-h')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const tabs = [
    { id: 'teams', label: 'Teams with open seats', count: stats?.recruitingTeams },
    { id: 'people', label: 'People looking for a team', count: stats?.lookingForTeam },
  ];

  return (
    <main id="main" className="page wrap stack">
      <section className="lead" aria-labelledby="hack-h">
        <div>
          <p className="kicker">Front page · Team formation</p>
          <h1 id="hack-h">{hackathon.name}</h1>
          <p className="deck">
            {hackathon.description ||
              `Teams of ${hackathon.minTeamSize} to ${hackathon.maxTeamSize}. Every seat is claimed in a transaction, so the last spot goes to exactly one person.`}
          </p>
          <div className="row" style={{ margin: '16px 0 18px' }}>
            <span className="pill pill-accent">
              Teams of {hackathon.minTeamSize}–{hackathon.maxTeamSize}
            </span>
            <span className="pill pill-green">Updates live</span>
            <span className="pill pill-amber">One team per person</span>
          </div>
          <Deadline closesAt={hackathon.teamFormationClosesAt} />
        </div>
        <MostWanted stats={stats} skill={skill} onPick={pickSkill} />
      </section>

      <StatsStrip stats={stats} />

      <div className="split">
        <MyStatus />
        <div className="sidebar">
          <Suggestions />
        </div>
      </div>

      <section aria-labelledby="classifieds-h">
        <div className="section-head">
          <h2 id="classifieds-h">The Classifieds</h2>
          <span className="tz">Newest first · changes appear without reloading</span>
        </div>
        <div className="board-controls">
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
                {t.count != null && (
                  <span className="count" aria-hidden="true">
                    {fmt(t.count)}
                  </span>
                )}
              </button>
            ))}
          </div>
          <form
            className="filter"
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
            <button className="btn btn-sm">Filter</button>
            {skill && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
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
        {skill && <p className="filter-note">Filtered by skill: “{skill}”</p>}

        <div id="board-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} aria-busy={board.loading}>
          {!board.loading && board.items.length === 0 && <Empty>Nothing here yet. Check back soon, this page updates by itself.</Empty>}
          <ul className="ads">
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
              <button className="btn btn-ghost" onClick={board.loadMore}>
                Load more
              </button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
