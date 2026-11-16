import { type Attributes, context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';

export interface TracingSettings {
  enabled: boolean;
  serviceName: string;
  otlpEndpoint: string;
}

let sdk: { shutdown(): Promise<void> } | undefined;

/**
 * Starts the OpenTelemetry Node SDK (OTLP/HTTP exporter). Disabled by default.
 * Under Bun the require-hook based auto-instrumentations may not patch modules, so the
 * important spans (HTTP use case, SQL transaction, SQS consume, outbox publish) are created
 * manually with `withSpan`, and the trace context is propagated through SQS message attributes.
 */
export async function startTracing(settings: TracingSettings): Promise<void> {
  if (!settings.enabled || sdk) return;
  const [{ NodeSDK }, { OTLPTraceExporter }, { HttpInstrumentation }, { PgInstrumentation }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-pg'),
  ]);
  const instance = new NodeSDK({
    serviceName: settings.serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${settings.otlpEndpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [new HttpInstrumentation(), new PgInstrumentation()],
  });
  instance.start();
  sdk = instance;
}

export async function stopTracing(): Promise<void> {
  const current = sdk;
  sdk = undefined;
  await current?.shutdown();
}

const tracer = trace.getTracer('wagering-processor');

/** Runs `fn` inside an active span. A no-op tracer is used when tracing is disabled. */
export function withSpan<T>(name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** W3C trace context of the active span, to be sent as message attributes. */
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function withExtractedTraceContext<T>(carrier: Record<string, string>, fn: () => T): T {
  return context.with(propagation.extract(context.active(), carrier), fn);
}
