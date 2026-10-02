import dns from 'node:dns/promises';
import { buildApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';
import { setupSockets } from './sockets/index.js';

async function main() {
  const app = await buildApp();

  // Attach Socket.IO
  const io = setupSockets(app);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    io.close();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    // ──────────────────────────────────────────────
    // Supabase DNS diagnostic
    // ──────────────────────────────────────────────
    try {
      const dnsResult = await dns.lookup(
        'uazduvgqosvocauawccv.supabase.co'
      );

      console.log('🔎 Supabase DNS:', dnsResult);
    } catch (error) {
      console.error('❌ Supabase DNS failed:', error);
    }

    // ──────────────────────────────────────────────
    // Start server
    // ──────────────────────────────────────────────
    await app.listen({
      port: env.PORT,
      host: '0.0.0.0',
    });

    console.log(
      `\n🚀  Chatrio server running on http://0.0.0.0:${env.PORT}`
    );
    console.log(`📡  Environment: ${env.NODE_ENV}`);
  } catch (err) {
    app.log.error(err);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();