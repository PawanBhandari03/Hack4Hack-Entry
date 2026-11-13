import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { io as connect } from 'socket.io-client';
import { app, api, makeHackathon, makeUsers, createTeamVia, inviteCode, joinWithCode } from './helpers.js';
import { attachSocket } from '../src/socket.js';
import { setIo } from '../src/lib/realtime.js';

let server;
let url;
let ioServer;

beforeAll(async () => {
  server = http.createServer(app);
  ioServer = attachSocket(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  setIo(null);
  ioServer.close();
  await new Promise((r) => server.close(r));
});

const client = (token) =>
  new Promise((resolve, reject) => {
    const s = connect(url, { auth: { token }, transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });

const nextEvent = (socket, event, predicate = () => true) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 5000);
    socket.on(event, (payload) => {
      if (predicate(payload)) {
        clearTimeout(t);
        resolve(payload);
      }
    });
  });

describe('real-time (Socket.io)', () => {
  it('rejects sockets without a valid token', async () => {
    await expect(client('nope')).rejects.toThrow('UNAUTHORIZED');
  });

  it('board viewers and team members see a join live, without refreshing', async () => {
    const h = await makeHackathon();
    const [leader, viewer, joiner] = await makeUsers(3);
    const team = await createTeamVia(leader, h._id);
    const code = await inviteCode(leader, team.id);

    const viewerSocket = await client(viewer.token);
    const leaderSocket = await client(leader.token);
    await viewerSocket.emitWithAck('board:subscribe', String(h._id));
    const sub = await leaderSocket.emitWithAck('team:subscribe', team.id);
    expect(sub.member).toBe(true);

    const boardUpdate = nextEvent(viewerSocket, 'board:team', (p) => p.id === team.id && p.memberCount === 2);
    const teamUpdate = nextEvent(leaderSocket, 'team:updated', (p) => p.teamId === team.id);
    expect((await joinWithCode(joiner, code)).status).toBe(200);

    const card = await boardUpdate;
    expect(card.openSeats).toBe(2);
    await teamUpdate;
    viewerSocket.close();
    leaderSocket.close();
  });

  it('non-members cannot subscribe to a team room', async () => {
    const h = await makeHackathon();
    const [leader, outsider] = await makeUsers(2);
    const team = await createTeamVia(leader, h._id);
    const s = await client(outsider.token);
    const res = await s.emitWithAck('team:subscribe', team.id);
    expect(res).toEqual({ ok: true, member: false });
    s.close();
  });
});

describe('real-time profile updates', () => {
  it('editing your skills updates your card on everyone\'s board live', async () => {
    const h = await makeHackathon();
    const [viewer, person] = await makeUsers(2);
    await api().get(`/api/hackathons/${h._id}/me`).set(person.auth); // registers person in the hackathon
    const s = await client(viewer.token);
    await s.emitWithAck('board:subscribe', String(h._id));

    const update = nextEvent(s, 'board:person', (p) => p.userId === person.id);
    const res = await api().patch('/api/auth/me').set(person.auth).send({ skills: ['rust', 'go'] });
    expect(res.status).toBe(200);
    expect((await update).skills).toEqual(['rust', 'go']);
    s.close();
  });
});
