import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../state.jsx';
import SkillInput from '../components/SkillInput.jsx';
import { Chips, Seats, Spinner, Empty, tzLabel } from '../components/common.jsx';

const ACTION_TEXT = {
  TEAM_CREATED: 'created the team',
  TEAM_UPDATED: 'updated team details',
  MEMBER_JOINED: 'added',
  MEMBER_LEFT: 'left the team',
  MEMBER_REMOVED: 'removed',
  LEADER_TRANSFERRED: 'made leader:',
  INVITE_CREATED: 'generated a new invite code',
  INVITES_REVOKED: 'revoked invite codes',
  JOIN_REQUESTED: 'asked to join',
  JOIN_REQUEST_CANCELLED: 'cancelled their request',
  REQUEST_ACCEPTED: 'accepted the request of',
  REQUEST_DECLINED: 'declined the request of',
  TEAM_DELETED: 'deleted the team',
};

function AuditLog({ teamId, version }) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    api(`/api/teams/${teamId}/audit`).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [teamId, version]);
  if (!items) return <Spinner />;
  return (
    <ol className="audit">
      {items.map((a) => (
        <li key={a.id}>
          <time dateTime={a.at}>{new Date(a.at).toLocaleString()}</time>
          <span>
            <strong>{a.actorName}</strong> {ACTION_TEXT[a.action] ?? a.action}
            {a.targetName && a.targetUserId !== a.actorId && <strong> {a.targetName}</strong>}
            {a.action === 'MEMBER_JOINED' && a.details?.via && <span className="muted"> (via {a.details.via})</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function InviteBox({ teamId }) {
  const { toastError, toast } = useApp();
  const [invite, setInvite] = useState(null);
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      setInvite(await api(`/api/teams/${teamId}/invites`, { method: 'POST' }));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    try {
      await api(`/api/teams/${teamId}/invites`, { method: 'DELETE' });
      setInvite(null);
      toast('All invite codes revoked');
    } catch (err) {
      toastError(err);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.code);
      toast('Copied to clipboard', 'success');
    } catch {
      /* clipboard blocked: code is visible anyway */
    }
  };

  return (
    <div className="stack-sm">
      {invite ? (
        <>
          <div className="row">
            <code className="invite-code" aria-label="Invite code">
              {invite.code}
            </code>
            <button className="btn btn-sm" onClick={copy}>
              Copy
            </button>
          </div>
          <p className="muted small">
            Expires {new Date(invite.expiresAt).toLocaleString()}. Codes are stored hashed, so you'll only see this once — generate a new one
            any time (the old one stops working).
          </p>
        </>
      ) : (
        <p className="muted small">Share an invite code with people you want — they join instantly, no approval needed.</p>
      )}
      <div className="row">
        <button className="btn btn-primary btn-sm" onClick={generate} disabled={busy}>
          {invite ? 'Generate new code' : 'Generate invite code'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={revoke}>
          Revoke all codes
        </button>
      </div>
    </div>
  );
}

function EditTeam({ team, onDone }) {
  const { toastError } = useApp();
  const [form, setForm] = useState({ name: team.name, description: team.description, skillsWanted: team.skillsWanted });
  const save = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/teams/${team.id}`, { method: 'PATCH', body: form });
      onDone();
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <form onSubmit={save} className="stack">
      <div className="field">
        <label htmlFor="ename">Team name</label>
        <input id="ename" value={form.name} minLength={2} maxLength={50} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="edesc">Description</label>
        <textarea id="edesc" rows={2} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
      <SkillInput label="Skills wanted" value={form.skillsWanted} onChange={(skillsWanted) => setForm({ ...form, skillsWanted })} />
      <div className="row">
        <button className="btn btn-primary btn-sm">Save</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function TeamPage() {
  const { teamId } = useParams();
  const { socket, user, mine, refreshMine, toast, toastError } = useApp();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);
  const [pendingAction, setPendingAction] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/teams/${teamId}`));
      setError(null);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err);
    }
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  // Live: subscribe to the team room (members only) and refetch on any change.
  useEffect(() => {
    if (!socket) return;
    const sub = () => socket.emit('team:subscribe', teamId);
    const onUpdate = (p) => p.teamId === teamId && load();
    const onDeleted = (p) => {
      if (p.teamId !== teamId) return;
      toast('This team was deleted');
      setData(null);
      setError({ code: 'TEAM_NOT_FOUND' });
    };
    const onRemoved = (p) => {
      if (p.teamId !== teamId) return;
      setData(null);
      setError({ code: 'TEAM_NOT_FOUND' });
    };
    // Board events also cover non-members watching this page (seat counts).
    const onBoardTeam = (t) => t.id === teamId && load();
    sub();
    socket.on('connect', sub);
    socket.on('connect', load);
    socket.on('team:updated', onUpdate);
    socket.on('team:requests', onUpdate);
    socket.on('team:deleted', onDeleted);
    socket.on('board:team-removed', onRemoved); // non-members hear about deletion via the hackathon room
    socket.on('board:team', onBoardTeam);
    return () => {
      socket.emit('team:unsubscribe', teamId);
      socket.off('connect', sub);
      socket.off('connect', load);
      socket.off('team:updated', onUpdate);
      socket.off('team:requests', onUpdate);
      socket.off('team:deleted', onDeleted);
      socket.off('board:team-removed', onRemoved);
      socket.off('board:team', onBoardTeam);
    };
  }, [socket, teamId, load, toast]);

  // Re-subscribe once I become a member (e.g. my request was accepted while I'm on this page).
  useEffect(() => {
    if (socket && data?.isMember) socket.emit('team:subscribe', teamId);
  }, [socket, data?.isMember, teamId]);

  const run = async (label, fn, after) => {
    setPendingAction(label);
    try {
      const res = await fn();
      await Promise.all([load(), refreshMine()]);
      after?.(res);
    } catch (err) {
      toastError(err);
      load();
    } finally {
      setPendingAction(null);
    }
  };

  if (error) {
    return (
      <main id="main" className="container">
        <Empty>{error.code === 'TEAM_NOT_FOUND' ? 'This team no longer exists.' : 'Could not load this team.'}</Empty>
        <Link to="/">← Back to the board</Link>
      </main>
    );
  }
  if (!data) return <Spinner />;

  const { team, members, isMember, isLeader, pendingRequests = [], myPendingRequest } = data;
  const inOtherTeam = mine?.team && mine.team.id !== team.id;

  return (
    <main id="main" className="container stack">
      <Link to="/" className="muted small">
        ← Board
      </Link>
      <section className="card stack" aria-labelledby="team-h">
        <div className="row-between wrap">
          <div>
            <h1 id="team-h">{team.name}</h1>
            <p className="muted">
              {team.meetsMinimum ? 'Meets the minimum team size' : `Forming — needs ${team.minSize - team.memberCount} more to reach the minimum of ${team.minSize}`}
              {!team.lookingForMembers && ' · Not recruiting'}
            </p>
          </div>
          <Seats memberCount={team.memberCount} maxSize={team.maxSize} />
        </div>
        {editing ? (
          <EditTeam
            team={team}
            onDone={() => {
              setEditing(false);
              load();
            }}
          />
        ) : (
          <>
            {team.description && <p>{team.description}</p>}
            {team.skillsWanted.length > 0 && (
              <div className="row small">
                <span className="muted">Looking for</span>
                <Chips items={team.skillsWanted} />
              </div>
            )}
          </>
        )}

        <div className="row wrap">
          {!isMember && !inOtherTeam && team.openSeats > 0 && team.lookingForMembers && (
            myPendingRequest ? (
              <button
                className="btn"
                disabled={!!pendingAction}
                onClick={() => run('cancel', () => api(`/api/requests/${myPendingRequest.id}/cancel`, { method: 'POST' }))}
              >
                Cancel my request
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={!!pendingAction}
                onClick={() => run('request', () => api(`/api/teams/${team.id}/requests`, { method: 'POST', body: {} }), () => toast('Request sent', 'success'))}
              >
                Request to join
              </button>
            )
          )}
          {!isMember && team.openSeats === 0 && <span className="badge">Team is full</span>}
          {isLeader && !editing && (
            <>
              <button className="btn btn-sm" onClick={() => setEditing(true)}>
                Edit team
              </button>
              <button
                className="btn btn-sm"
                onClick={() => run('recruit', () => api(`/api/teams/${team.id}`, { method: 'PATCH', body: { lookingForMembers: !team.lookingForMembers } }))}
              >
                {team.lookingForMembers ? 'Stop recruiting' : 'Start recruiting'}
              </button>
            </>
          )}
          {isMember && (
            <button
              className="btn btn-danger btn-sm"
              disabled={!!pendingAction}
              onClick={() => {
                const last = team.memberCount === 1;
                const msg = last
                  ? 'You are the last member. Leaving will DELETE the team. Continue?'
                  : isLeader
                    ? 'Leadership will pass to the longest-standing member. Leave the team?'
                    : 'Leave this team?';
                if (!window.confirm(msg)) return;
                run('leave', () => api(`/api/teams/${team.id}/leave`, { method: 'POST' }), () => navigate('/'));
              }}
            >
              Leave team
            </button>
          )}
        </div>
      </section>

      <div className="grid-2 align-start">
        <section className="card stack" aria-labelledby="members-h">
          <h2 id="members-h" className="h-sm">
            Members
          </h2>
          <ul className="list">
            {members.map((m) => (
              <li key={m.userId} className="list-row stack-sm">
                <div className="row-between wrap">
                  <div>
                    <strong>{m.name}</strong> {m.role === 'leader' && <span className="badge badge-accent">Leader</span>}
                    {m.userId === user.id && <span className="muted small"> (you)</span>}
                    <div className="muted small">{tzLabel(m.timezone)}</div>
                  </div>
                  {isLeader && m.userId !== user.id && (
                    <div className="row">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() =>
                          window.confirm(`Make ${m.name} the leader? You will become a regular member.`) &&
                          run('transfer', () => api(`/api/teams/${team.id}/leader`, { method: 'POST', body: { userId: m.userId } }))
                        }
                      >
                        Make leader
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() =>
                          window.confirm(`Remove ${m.name} from the team?`) &&
                          run('remove', () => api(`/api/teams/${team.id}/members/${m.userId}`, { method: 'DELETE' }))
                        }
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
                <Chips items={m.skills} highlight={team.skillsWanted} />
              </li>
            ))}
          </ul>
        </section>

        {isLeader && (
          <div className="stack">
            <section className="card stack" aria-labelledby="req-h">
              <h2 id="req-h" className="h-sm">
                Join requests {pendingRequests.length > 0 && <span className="badge badge-accent">{pendingRequests.length}</span>}
              </h2>
              {pendingRequests.length === 0 ? (
                <Empty>No pending requests.</Empty>
              ) : (
                <ul className="list">
                  {pendingRequests.map((r) => (
                    <li key={r.id} className="list-row stack-sm">
                      <div className="row-between wrap">
                        <strong>{r.userName}</strong>
                        <div className="row">
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={!!pendingAction || team.openSeats === 0}
                            onClick={() => run('accept', () => api(`/api/requests/${r.id}/accept`, { method: 'POST' }))}
                          >
                            Accept
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={!!pendingAction}
                            onClick={() => run('decline', () => api(`/api/requests/${r.id}/decline`, { method: 'POST' }))}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                      <Chips items={r.userSkills} highlight={team.skillsWanted} />
                      {r.message && <p className="small">"{r.message}"</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card" aria-labelledby="inv-h">
              <h2 id="inv-h" className="h-sm">
                Invite code
              </h2>
              <InviteBox teamId={team.id} />
            </section>
          </div>
        )}
      </div>

      {isMember && (
        <section className="card" aria-labelledby="audit-h">
          <h2 id="audit-h" className="h-sm">
            Activity log
          </h2>
          <AuditLog teamId={team.id} version={version} />
        </section>
      )}
    </main>
  );
}
