import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader, MeterProvider } from '@opentelemetry/sdk-metrics';
import { trace, metrics } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { logger } from '../lib/logger.js';

export function initRealTelemetry(): {
  tracer: ReturnType<typeof trace.getTracer>;
  meter: ReturnType<typeof metrics.getMeter>;
  shutdown: () => Promise<void>;
} {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  const serviceName = process.env.OTEL_SERVICE_NAME || 'agent-factory';

  const resource = new Resource({ [ATTR_SERVICE_NAME]: serviceName });

  const traceExporter = new OTLPTraceExporter({
    url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter,
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${endpoint.replace(/\/$/, '')}/v1/metrics`,
    }),
    exportIntervalMillis: 15_000,
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [metricReader],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  sdk.start();

  const otelTracer = trace.getTracer(serviceName);
  const otelMeter = meterProvider.getMeter(serviceName);

  logger.info({ endpoint, serviceName }, 'OpenTelemetry initialized (static imports)');

  const shutdown = async () => {
    await sdk.shutdown();
    logger.info('OpenTelemetry shut down');
  };

  return { tracer: otelTracer, meter: otelMeter, shutdown };
}
