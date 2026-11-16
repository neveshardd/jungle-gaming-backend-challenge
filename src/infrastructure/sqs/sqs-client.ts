import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/config';

export function createSqsClient(aws: AppConfig['aws']): SQSClient {
  return new SQSClient({
    region: aws.region,
    endpoint: aws.endpoint,
    credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey },
    maxAttempts: 3,
  });
}
