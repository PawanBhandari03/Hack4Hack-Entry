/**
 * Socket.io setup.
 *
 * Rooms:
 *   hackathon:<id>  - the live board (team cards + people looking)
 *   team:<id>       - a team page (members, requests). Only MEMBERS may join it.
 *   user:<id>       - private notifications (request accepted, "you are now leader"...)
 *
 * Clients authenticate with the same JWT as the REST API (handshake.auth.token).
 * Events are tiny "something changed" signals or summaries; on reconnect the client
 * simply refetches over REST, so a missed event can never leave the UI permanently wrong.
 */
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { config } from './config.js';
import { verifyToken } from './middleware/auth.js';
import { rooms, setIo } from './lib/realtime.js';
import { Participant, Team } from './models/index.js';

export function attachSocket(httpServer) {
  const io = new Server(httpServer, { cors: { origin: config.clientOrigins } });

  io.use((socket, next) => {
    try {
      socket.data.userId = verifyToken(socket.handshake.auth?.token);
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    socket.join(rooms.user(userId));

    socket.on('board:subscribe', (hackathonId, ack) => {
      if (!mongoose.isValidObjectId(hackathonId)) return ack?.({ ok: false });
      socket.join(rooms.hackathon(hackathonId));
      ack?.({ ok: true });
    });

    socket.on('board:unsubscribe', (hackathonId) => socket.leave(rooms.hackathon(hackathonId)));

    // Team pages are public to view, but live details (requests etc.) only go to members.
    socket.on('team:subscribe', async (teamId, ack) => {
      if (!mongoose.isValidObjectId(teamId)) return ack?.({ ok: false });
      const [isMember, exists] = await Promise.all([
        Participant.exists({ teamId, userId }),
        Team.exists({ _id: teamId }),
      ]);
      if (!exists) return ack?.({ ok: false });
      if (isMember) socket.join(rooms.team(teamId));
      ack?.({ ok: true, member: Boolean(isMember) });
    });

    socket.on('team:unsubscribe', (teamId) => socket.leave(rooms.team(teamId)));
  });

  setIo(io);
  return io;
}
