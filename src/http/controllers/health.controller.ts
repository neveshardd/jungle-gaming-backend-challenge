import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthCheck } from '../../infrastructure/health/health-check';
import { PrometheusMetrics } from '../../observability/metrics';

/** Health and metrics are intentionally unauthenticated. */
@Controller()
export class HealthController {
  constructor(
    @Inject(HealthCheck) private readonly health: HealthCheck,
    @Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics,
  ) {}

  /** Liveness: the process is up and the event loop answers. No dependency checks. */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL and SQS reachable, and the instance is not draining. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.health.readiness();
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }

  @Get('metrics')
  async metricsEndpoint(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}
