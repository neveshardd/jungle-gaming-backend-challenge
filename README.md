# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por **HTTP** e **SQS**. Ele continua correto quando as mensagens chegam duplicadas, fora de ordem ou de forma concorrente, com várias instâncias rodando, e se recupera de crash antes ou depois do commit.

- Stack: **Bun 1.x**, **TypeScript estrito**, **NestJS** (apenas a borda HTTP), **PostgreSQL 16**, **MikroORM 6** e **AWS SQS via LocalStack**, orquestrados por **Docker Compose**.
- Decisões, trade-offs e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md). O enunciado original está em [CHALLENGE.md](CHALLENGE.md).

## Pré-requisitos

- Docker com Docker Compose v2 (no Windows, o Docker Desktop com backend WSL2)
- Bun 1.x, para rodar os testes e o teste de carga a partir do host

## Subir o ambiente completo

```bash
docker compose up -d --build
```

O comando sobe o seguinte:

| Serviço | Papel |
|---|---|
| `postgres` | PostgreSQL 16, com o banco `wagering` e o banco `wagering_test` |
| `localstack` | SQS. As filas são criadas pela própria aplicação: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wallet-events.fifo` |
| `migrate` | Roda as migrations uma vez (`bun src/infrastructure/database/migrate.ts up`) |
| `app` ×3 | Três réplicas com `APP_ROLE=all`: HTTP, consumidor SQS, publisher da outbox e worker de referências pendentes |
| `lb` | nginx em `http://localhost:8080`, em round-robin entre as réplicas |
| `jaeger` | Opcional, ativado com `--profile otel`, em `http://localhost:16686` |

Para ligar os traces:

```bash
OTEL_ENABLED=true docker compose --profile otel up -d --build
```

## Exemplos

```bash
# criar wallet
curl -s -X POST localhost:8080/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# aposta (troque WALLET_ID)
curl -s -X POST localhost:8080/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

# consultas
curl -s localhost:8080/wallets/WALLET_ID
curl -s "localhost:8080/wallets/WALLET_ID/ledger?limit=50"
curl -s localhost:8080/providers/provider-a/wagering/transactions/transaction-123
curl -s -X POST localhost:8080/wallets/WALLET_ID/reconciliation

# operação
curl -s localhost:8080/health/live
curl -s localhost:8080/health/ready
curl -s localhost:8080/metrics
```

Para publicar uma mensagem na fila, via LocalStack:

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id WALLET_ID --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp","kind":"WIN","money":{"amount":"50.00","currency":"BRL"}}}'
```

## Testes

Os testes de integração e de concorrência usam **PostgreSQL e LocalStack reais**, sem mocks.

```bash
bun install
docker compose up -d postgres localstack   # infraestrutura de teste
```

```bash
bun run test:unit          # domínio puro: Money, Wallet, regras, transições, hash
bun run test:integration   # schema/constraints, fluxos, HTTP, SQS (inbox, retry, DLQ), outbox, pending reference
bun run test:concurrency   # os 8 cenários de concorrência (inclui 3 processos reais e crash por SIGKILL)
bun test                   # tudo
bun run typecheck
```

Para rodar a suíte inteira dentro do Linux, que é o ambiente recomendado no Windows porque lá o `SIGTERM` gracioso é testável:

```bash
docker compose --profile test run --rm tests
```

Variáveis úteis para os testes:

- `TEST_DATABASE_URL`: padrão `postgres://wagering:wagering@localhost:5432/wagering_test`
- `AWS_ENDPOINT_URL`: padrão `http://localhost:4566`
- `TEST_LOG_LEVEL=debug`: mostra os logs das instâncias durante os testes

> Cada arquivo de teste recria o schema `public` do banco `wagering_test` aplicando as migrations reais. Não aponte os testes para o banco de produção.

## Teste de carga

Com o ambiente completo no ar (`docker compose up -d --build`):

```bash
DURATION_S=60 CONCURRENCY=50 bun run test:load
```

A metodologia e os resultados estão em [docs/LOAD_TEST.md](docs/LOAD_TEST.md).

## Configuração

Todas as variáveis, com os valores padrão, estão em [.env.example](.env.example). As principais:

| Variável | Padrão | Descrição |
|---|---|---|
| `APP_ROLE` | `all` | `api` (só HTTP), `worker` (consumidor, outbox e pending reference) ou `all` |
| `DATABASE_URL` | `postgres://…/wagering` | conexão com o PostgreSQL |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima pelo lock da wallet, depois disso o erro é tratado como transitório |
| `DB_TX_MAX_RETRIES` | `3` | quantas vezes uma transação é refeita após deadlock, lock timeout ou queda de conexão |
| `SQS_MAX_ATTEMPTS` | `5` | tentativas antes de a mensagem ir para a DLQ |
| `OUTBOX_LEASE_MS` | `30000` | lease de um lote da outbox, recuperado se a instância morrer |
| `PENDING_REF_MAX_ATTEMPTS` | `10` | orçamento de espera por uma referência ausente (cerca de 13,5 min) |
| `OTEL_ENABLED` | `false` | liga o OpenTelemetry (OTLP/HTTP) |

## Estrutura

```
src/
  shared/         Money, erros, portas (UnitOfWork, Logger, Metrics), JSON canônico
  wallet/         domínio (Wallet, WalletLedgerEntry) e casos de uso (abrir, consultar, reconciliar)
  wagering/       domínio (WagerTransaction, regras, FailureCode) e casos de uso (processar, resolver pendências)
  messaging/      Inbox, Outbox, IntegrationEvent e eventos concretos
  infrastructure/ MikroORM, migrations, repositórios SQL, SQS (consumidor, publisher, topologia), workers, health
  observability/  logs (pino), métricas (Prometheus), tracing (OpenTelemetry), contexto de correlação
  http/           NestJS: controllers, filtro de erros, guard de autenticação (no-op)
  bootstrap/      composition root (Container)
test/
  unit/ integration/ concurrency/ load/ support/
```
