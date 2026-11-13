import http from 'node:http';
import mongoose from 'mongoose';
import { config } from './config.js';
import { createApp } from './app.js';
import { attachSocket } from './socket.js';
import { syncAllIndexes, Hackathon } from './models/index.js';

async function main() {
  await mongoose.connect(config.mongoUri, { maxPoolSize: 50 });
  await syncAllIndexes();
  // Make sure there is always at least one hackathon to form teams in.
  await Hackathon.updateOne(
    { slug: 'hack4hack-demo-2026' },
    {
      $setOnInsert: {
        name: 'Hack4Hack Demo Hackathon 2026',
        description: 'Demo hackathon with 10,000 participants for the team-formation service.',
        minTeamSize: 2,
        maxTeamSize: 4,
      },
    },
    { upsert: true }
  );

  const app = createApp();
  const server = http.createServer(app);
  attachSocket(server);
  server.listen(config.port, () => console.log(`API listening on :${config.port}`));

  const shutdown = async () => {
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
