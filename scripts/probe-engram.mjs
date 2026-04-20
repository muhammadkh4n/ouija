// Fire a synthetic `notification.send` event on the bus to prove that
// plugin-engram picks it up and calls engram-ingest.
//
// Run with the ouija server running + OUIJA_ENGRAM_ENABLED=1 set in the
// server's env. The event flows through BullMQ → orchestrator subscription
// → EngramNotifyPlugin.send → engram-ingest CLI → Engram memory graph.
//
// Usage:
//   OUIJA_REDIS_URL=redis://localhost:6379 node scripts/probe-engram.mjs

import { BullMQEventBus } from '@ouija-dev/bus';

const bus = new BullMQEventBus({
  url: process.env.OUIJA_REDIS_URL ?? 'redis://localhost:6379',
});

const id = await bus.publish(
  'notification.send',
  {
    title: 'plugin-engram E2E probe',
    body: `Synthetic smoke at ${new Date().toISOString()} — should land in Engram memory.`,
    level: 'info',
    idempotencyKey: `probe-${Date.now()}`,
    instanceId: '00000000-0000-0000-0000-000000000000',
  },
  {
    sourcePlugin: 'ouija-engram-probe',
  },
);

console.log('published event id', id);

try {
  await bus.close?.();
} catch {}
process.exit(0);
