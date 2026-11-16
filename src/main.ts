import 'reflect-metadata';
import { Container } from './bootstrap/container';
import { loadConfig } from './config/config';
import { createHttpApp } from './http/app-factory';
import { startTracing, stopTracing } from './observability/tracing';

async function main(): Promise<void> {
  const config = loadConfig();
  await startTracing(config.tracing);

  const container = await Container.create(config);
  const { logger } = container;
  const app = await createHttpApp(container, config.role);
  await app.listen(config.port, '0.0.0.0');

  if (config.role !== 'api') container.startWorkers();
  logger.info({ role: config.role, port: config.port }, 'wagering processor started');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown requested: draining');
    const hardStop = setTimeout(() => {
      logger.error({}, 'graceful shutdown timed out; exiting');
      process.exit(1);
    }, config.shutdownGraceMs + 5000);
    try {
      container.health.markDraining();
      // 1) stop taking new work and finish in-flight messages (or hand them back to SQS)
      await container.stopWorkers(config.shutdownGraceMs);
      // 2) stop HTTP (Nest waits for open requests to complete)
      await app.close();
      // 3) release pools
      await container.close();
      await stopTracing();
      clearTimeout(hardStop);
      logger.info({}, 'shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', message: 'failed to start', error: String(err) }));
  process.exit(1);
});
