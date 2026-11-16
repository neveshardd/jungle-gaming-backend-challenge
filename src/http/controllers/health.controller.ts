import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthCheck } from '../../infrastructure/health/health-check';
import { PrometheusMetrics } from '../../observability/metrics';

/** Health and metrics are intentionally unauthenticated. */
@ApiTags('operations')
@Controller()
export class HealthController {
  constructor(
    @Inject(HealthCheck) private readonly health: HealthCheck,
    @Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics,
  ) {}

  /** Liveness: the process is up and the event loop answers. No dependency checks. */
  @Get('health/live')
  @ApiOperation({ summary: 'Liveness: processo vivo' })
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL and SQS reachable, and the instance is not draining. */
  @Get('health/ready')
  @ApiOperation({ summary: 'Readiness: PostgreSQL e SQS alcançáveis (503 durante o shutdown)' })
  @ApiResponse({ status: 200, description: 'Pronto' })
  @ApiResponse({ status: 503, description: 'Dependência indisponível ou instância drenando' })
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.health.readiness();
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Métricas Prometheus (texto)' })
  async metricsEndpoint(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}
