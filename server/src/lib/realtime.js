/**
 * Tiny publish layer over Socket.io.
 * Services never emit directly: they push events into a list, and the list is published
 * ONLY after the database transaction commits. If the transaction aborts, nothing is sent,
 * so clients can never see a change that was rolled back.
 */
let io = null;

export function setIo(instance) {
  io = instance;
}

export const rooms = {
  hackathon: (id) => `hackathon:${id}`,
  team: (id) => `team:${id}`,
  user: (id) => `user:${id}`,
};

/**
 * Called with the hackathon id whenever a board-visible change is published, even with no
 * sockets attached. The board service uses it to drop its read cache, so a page loaded right
 * after a change never shows the old seat count.
 */
const boardChangeListeners = [];
export function onBoardChange(fn) {
  boardChangeListeners.push(fn);
}

export function publish(events) {
  if (!events?.length) return;
  const changed = new Set(events.filter((e) => e.event.startsWith('board:')).map((e) => e.room.slice('hackathon:'.length)));
  for (const hackathonId of changed) for (const fn of boardChangeListeners) fn(hackathonId);
  if (!io) return;
  for (const { room, event, payload } of events) {
    io.to(room).emit(event, payload);
  }
}
