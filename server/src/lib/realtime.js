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

export function publish(events) {
  if (!io || !events?.length) return;
  for (const { room, event, payload } of events) {
    io.to(room).emit(event, payload);
  }
}
