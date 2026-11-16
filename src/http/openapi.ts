import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/**
 * OpenAPI description of the HTTP API (served at /docs, raw JSON at /docs-json).
 * Request validation is done with zod; these schemas mirror those contracts explicitly
 * instead of relying on reflected DTO classes.
 */
export const ref = (name: keyof typeof SCHEMAS) => ({ $ref: `#/components/schemas/${name}` });

const money: SchemaObject = {
  type: 'object',
  required: ['amount', 'currency'],
  properties: {
    amount: {
      type: 'string',
      pattern: '^(0|[1-9]\\d{0,17})\\.\\d{2}$',
      description: 'Decimal string with exactly 2 decimal places. Numbers, "25", "25.0", "1e3", negatives are rejected.',
      example: '25.00',
    },
    currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'ISO-4217', example: 'BRL' },
  },
};

const errorBody: SchemaObject = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'string', example: 'IDEMPOTENCY_CONFLICT' },
    message: { type: 'string' },
    correlationId: { type: 'string' },
    details: { description: 'Optional structured details (e.g. validation issues)' },
  },
};

export const SCHEMAS = {
  Money: money,
  Error: errorBody,
  CreateWalletRequest: {
    type: 'object',
    required: ['playerId', 'initialBalance'],
    properties: {
      playerId: { type: 'string', maxLength: 128, example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' },
      initialBalance: { $ref: '#/components/schemas/Money' },
    },
    example: {
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    },
  },
  CreateWalletResponse: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      playerId: { type: 'string' },
      balance: { $ref: '#/components/schemas/Money' },
      version: { type: 'integer', example: 1 },
    },
  },
  Wallet: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      playerId: { type: 'string' },
      balance: { $ref: '#/components/schemas/Money' },
      version: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  LedgerEntry: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      transactionId: { type: 'string', format: 'uuid' },
      direction: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
      money: { $ref: '#/components/schemas/Money' },
      balanceBefore: { $ref: '#/components/schemas/Money' },
      balanceAfter: { $ref: '#/components/schemas/Money' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  LedgerPage: {
    type: 'object',
    properties: {
      walletId: { type: 'string', format: 'uuid' },
      entries: { type: 'array', items: { $ref: '#/components/schemas/LedgerEntry' } },
      nextCursor: { type: 'string', nullable: true, description: 'Opaque cursor for the next page; null on the last page' },
    },
  },
  WagerRequest: {
    type: 'object',
    required: ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money'],
    properties: {
      providerId: { type: 'string', maxLength: 128 },
      externalTransactionId: { type: 'string', maxLength: 128 },
      playerId: { type: 'string', maxLength: 128 },
      walletId: { type: 'string', format: 'uuid' },
      roundId: { type: 'string', maxLength: 128 },
      gameId: { type: 'string', maxLength: 128 },
      kind: {
        type: 'string',
        enum: ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'],
        description: 'OPENING is internal and rejected (400 KIND_NOT_ALLOWED)',
      },
      money: { $ref: '#/components/schemas/Money' },
      referenceExternalTransactionId: {
        type: 'string',
        description: 'Required for REFUND/ROLLBACK; optional for WIN/LOSS (the BET of the same round)',
      },
    },
    example: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: 'COLE-AQUI-O-ID-DA-WALLET',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
  },
  WagerResult: {
    type: 'object',
    properties: {
      transactionId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['PROCESSED', 'PENDING_REFERENCE', 'REJECTED', 'FAILED'] },
      balance: { $ref: '#/components/schemas/Money' },
      failureCode: {
        type: 'string',
        enum: [
          'INSUFFICIENT_FUNDS',
          'REVERSAL_WOULD_OVERDRAW',
          'CURRENCY_MISMATCH',
          'WALLET_PLAYER_MISMATCH',
          'REFERENCE_NOT_FOUND',
          'REFERENCE_MISMATCH',
          'REFERENCE_KIND_NOT_ALLOWED',
          'REFERENCE_NOT_PROCESSED',
          'REFERENCE_AMOUNT_MISMATCH',
          'ALREADY_REVERSED',
          'PROCESSING_ERROR',
        ],
      },
      idempotentReplay: { type: 'boolean' },
    },
  },
  WagerTransaction: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      providerId: { type: 'string' },
      externalTransactionId: { type: 'string' },
      idempotencyKey: { type: 'string' },
      walletId: { type: 'string', format: 'uuid' },
      playerId: { type: 'string' },
      roundId: { type: 'string' },
      gameId: { type: 'string' },
      kind: { type: 'string', enum: ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] },
      money: { $ref: '#/components/schemas/Money' },
      status: { type: 'string', enum: ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] },
      referenceExternalTransactionId: { type: 'string' },
      referenceTransactionId: { type: 'string', format: 'uuid' },
      failureCode: { type: 'string' },
      resultBalance: { $ref: '#/components/schemas/Money' },
      referenceAttempts: { type: 'integer' },
      nextAttemptAt: { type: 'string', format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
      processedAt: { type: 'string', format: 'date-time' },
    },
  },
  Reconciliation: {
    type: 'object',
    properties: {
      walletId: { type: 'string', format: 'uuid' },
      storedBalance: { $ref: '#/components/schemas/Money' },
      calculatedBalance: { $ref: '#/components/schemas/Money' },
      difference: { $ref: '#/components/schemas/Money' },
      consistent: { type: 'boolean' },
      checkedEntries: { type: 'integer' },
      checks: {
        type: 'object',
        properties: {
          balanceMatchesLedgerSum: { type: 'boolean' },
          balanceMatchesLastEntry: { type: 'boolean' },
          ledgerChainIntact: { type: 'boolean' },
          versionMatchesMovements: { type: 'boolean' },
        },
      },
    },
  },
} satisfies Record<string, SchemaObject>;

const DESCRIPTION = `
Processador distribuído de apostas (BET, WIN, LOSS, REFUND, ROLLBACK).

**Como testar rápido**
1. \`POST /wallets\` para criar uma wallet e copiar o \`id\` da resposta.
2. \`POST /wagering/transactions\` com esse \`walletId\` e um \`Idempotency-Key\` (ex.: \`provider-a:transaction-123\`).
3. Repita o mesmo request: **200** com \`idempotentReplay: true\` e o saldo original.
4. Mude o valor e mantenha a mesma chave: **409 IDEMPOTENCY_CONFLICT**.
5. \`GET /wallets/{id}/ledger\` e \`POST /wallets/{id}/reconciliation\`.

**Mapeamento de status (igual em todos os endpoints)**
| Status | Significado |
|---|---|
| 201 | processada |
| 200 | replay idempotente (resultado original) |
| 202 | aceita, aguardando a transação referenciada (PENDING_REFERENCE) |
| 400 | payload inválido |
| 404 | recurso inexistente |
| 409 | conflito de idempotência / unicidade |
| 422 | rejeição de negócio persistida, com \`failureCode\` |
| 503 | falha transitória — reenviar com a mesma chave (Retry-After) |

Autenticação: não implementada (ponto de extensão \`ProviderAuthGuard\`), ver ARCHITECTURE.md §13.
`;

export function setupOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Distributed Wagering Processor')
    .setDescription(DESCRIPTION)
    .setVersion('1.0.0')
    .addTag('wallets', 'Criação, consulta, ledger e reconciliação')
    .addTag('wagering', 'Submissão e consulta de transações de aposta')
    .addTag('operations', 'Health checks e métricas (sem autenticação)')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  document.components = { ...document.components, schemas: { ...document.components?.schemas, ...SCHEMAS } };
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, tryItOutEnabled: true },
  });
}
