# Distributed Wagering Processor

Solução do **Technical Challenge da Jungle Gaming** ([enunciado](CHALLENGE.md)): um serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por **HTTP** e por **AWS SQS**.

O serviço continua correto quando as mensagens chegam **duplicadas**, **fora de ordem** ou **em paralelo** em várias instâncias, e se recupera de crash antes ou depois do commit.

| | |
|---|---|
| **Stack** | Bun 1.x · TypeScript estrito · NestJS · PostgreSQL 16 · MikroORM 6 · SQS (LocalStack) · Docker Compose |
| **Garantias** | idempotência persistente · lock pessimista por wallet · ledger append-only · inbox e outbox transacionais · invariantes aplicadas **no schema** |
| **Testes** | 189 testes (unidade, integração e concorrência) com **Postgres e LocalStack reais**, incluindo 3 processos simultâneos e crash por `SIGKILL` |
| **Interfaces** | console de teste (React + Material UI) e Swagger |

As decisões técnicas, os trade-offs e as limitações estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**. Os números do teste de carga estão em **[docs/LOAD_TEST.md](docs/LOAD_TEST.md)**.

---

## Sumário

1. [Início rápido](#1-início-rápido)
2. [Como usar](#2-como-usar)
3. [API](#3-api)
4. [Mensageria (SQS)](#4-mensageria-sqs)
5. [Configuração](#5-configuração)
6. [Testes](#6-testes)
7. [Teste de carga](#7-teste-de-carga)
8. [Arquitetura em resumo](#8-arquitetura-em-resumo)
9. [Estrutura do projeto](#9-estrutura-do-projeto)
10. [Solução de problemas](#10-solução-de-problemas)

---

## 1. Início rápido

### Pré-requisitos

| Ferramenta | Versão | Para quê |
|---|---|---|
| Docker + Docker Compose v2 | 24+ | subir o ambiente completo (obrigatório) |
| Bun | 1.x | rodar os testes e o teste de carga a partir do host (opcional) |

> **Windows:** use o Docker Desktop com o backend WSL2 (`wsl --install`).

### Subir tudo

```bash
git clone https://github.com/neveshardd/jungle-gaming-backend-challenge.git
cd jungle-gaming-backend-challenge
docker compose up -d --build
```

A primeira subida leva alguns minutos, porque é preciso baixar as imagens e instalar as dependências. Depois disso, ficam disponíveis:

| Endereço | O que é |
|---|---|
| **http://localhost:5173** | **Console de teste**: interface para usar o sistema |
| **http://localhost:8080/docs** | **Swagger**: documentação interativa da API |
| http://localhost:8080 | API (nginx em round-robin entre as 3 réplicas) |
| http://localhost:8080/health/ready | readiness (Postgres e SQS) |
| http://localhost:8080/metrics | métricas Prometheus |

Os serviços do Compose:

| Serviço | Papel |
|---|---|
| `postgres` | PostgreSQL 16 (bancos `wagering` e `wagering_test`) |
| `localstack` | SQS. As filas FIFO são criadas pela própria aplicação |
| `migrate` | aplica as migrations uma única vez e encerra |
| `app` ×3 | três réplicas da aplicação (`APP_ROLE=all`): HTTP, consumidor SQS, publisher da outbox e worker de referências pendentes |
| `lb` | nginx na porta 8080 |
| `web` | console de teste na porta 5173 |
| `jaeger` | opcional (`--profile otel`), traces em http://localhost:16686 |

Para desligar:

```bash
docker compose down        # mantém os dados
docker compose down -v     # apaga também o banco
```

---

## 2. Como usar

### Pelo console (http://localhost:5173)

1. **Criar uma wallet:** informe o saldo inicial e clique em **Criar**. O campo tem máscara de centavos: digitando `100000`, ele mostra `R$ 1.000,00` e envia `"1000.00"`.
2. **Enviar transações:** escolha o tipo (BET, WIN, LOSS, REFUND ou ROLLBACK), o valor e, para REFUND/ROLLBACK, a referência (o campo sugere as transações já enviadas). Depois clique em **Enviar**.
3. **Ver a idempotência na prática:**
   - **Replay** reenvia o último request com a mesma chave e o mesmo payload. A resposta é `200`, com `idempotentReplay: true` e o **saldo original**.
   - **Conflito** reenvia a mesma chave com outro valor. A resposta é `409 IDEMPOTENCY_CONFLICT`.
4. **Ledger e reconciliação:** a tabela mostra cada lançamento com o saldo antes e depois. O botão **Reconciliar** compara o saldo armazenado com o saldo reconstruído pelo ledger.
5. **Cenários do desafio**, um clique cada: duas apostas de 80 em paralelo, a mesma aposta 50× em paralelo, conflito de chave, REFUND antes da BET, ROLLBACK de WIN sem saldo e REFUND + ROLLBACK da mesma BET. Cada cenário cria a própria wallet e mostra ✓/✗ com os detalhes.
6. **Atividade:** cada requisição aparece com status, `Idempotency-Key`, correlation id, request e response.

Opções em **Avançado**: `externalTransactionId`, `roundId` e `providerId`.

### Pelo Swagger (http://localhost:8080/docs)

Todos os endpoints estão lá, com schemas, exemplos e todos os códigos de status. A descrição traz um roteiro de teste. O documento OpenAPI fica em `/docs-json`.

### Por linha de comando

```bash
# 1) criar wallet (guarde o "id" e o "playerId" da resposta)
curl -s -X POST localhost:8080/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# 2) aposta (troque WALLET_ID). Reenviar o MESMO comando devolve 200 com idempotentReplay=true
curl -s -X POST localhost:8080/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

# 3) consultas
curl -s localhost:8080/wallets/WALLET_ID
curl -s "localhost:8080/wallets/WALLET_ID/ledger?limit=50"
curl -s localhost:8080/providers/provider-a/wagering/transactions/transaction-123
curl -s -X POST localhost:8080/wallets/WALLET_ID/reconciliation
```

---

## 3. API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria a wallet. Saldo inicial > 0 gera uma transação interna `OPENING` com CREDIT no ledger, na mesma transação SQL |
| `GET` | `/wallets/:walletId` | saldo e `version` |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | ledger paginado (cursor estável e opaco, limit de 1 a 200) |
| `POST` | `/wallets/:walletId/reconciliation` | compara o saldo com o ledger. **Nunca corrige**: só reporta, loga e conta em métrica |
| `POST` | `/wagering/transactions` | submete uma transação. **Header `Idempotency-Key` obrigatório** |
| `GET` | `/wagering/transactions/:transactionId` | consulta pelo id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET` | `/health/live`, `/health/ready` | liveness e readiness (sem autenticação) |
| `GET` | `/metrics` | métricas Prometheus |
| `GET` | `/docs`, `/docs-json` | Swagger UI e OpenAPI |

**Dinheiro:** é sempre uma string decimal com 2 casas, `{"amount":"25.00","currency":"BRL"}`. A API rejeita números, `"25"`, `"25.0"`, `"1e3"`, negativos, `NaN` e mais de 2 casas.

**Status HTTP** (o mesmo mapeamento em todos os endpoints, para o provedor decidir sem interpretar a mensagem de erro):

| Status | Significado | Reenviar? |
|---|---|---|
| `201` | transação processada | — |
| `200` | replay idempotente (devolve o resultado e o saldo **originais**) | — |
| `202` | aceita, aguardando a transação referenciada (`PENDING_REFERENCE`) | não; consultar via GET |
| `400` | payload inválido (`VALIDATION_ERROR`, `INVALID_MONEY`, `KIND_NOT_ALLOWED`…) | só depois de corrigir |
| `404` | recurso inexistente (`WALLET_NOT_FOUND`…) | não |
| `409` | conflito de idempotência ou unicidade (`IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS`…) | não |
| `422` | rejeição de negócio **persistida**, com `failureCode` (`INSUFFICIENT_FUNDS`, `ALREADY_REVERSED`…) | não com a mesma chave |
| `503` | falha transitória de infraestrutura (+ `Retry-After`) | **sim, com a mesma chave** |

A taxonomia completa de `failureCode`, com o que o provedor deve fazer em cada caso, está em [ARCHITECTURE.md §9](ARCHITECTURE.md).

**Autenticação:** não foi implementada, por decisão (não vale pontos no desafio). O ponto de extensão `ProviderAuthGuard` / `ProviderIdentityPort` está no código, e o desenho com Keycloak está em [ARCHITECTURE.md §13](ARCHITECTURE.md).

---

## 4. Mensageria (SQS)

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | entrada de transações (o mesmo caso de uso do HTTP) |
| `wager-transactions-dlq.fifo` | mensagens com contrato inválido ou com as tentativas esgotadas |
| `wallet-events.fifo` | eventos publicados pela outbox: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference` e `WagerTransactionFailed` |

Para publicar uma mensagem de teste (troque `WALLET_ID` e `PLAYER_ID`):

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id WALLET_ID --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124","playerId":"PLAYER_ID","walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp","kind":"WIN","money":{"amount":"50.00","currency":"BRL"}}}'
```

Para ler os eventos publicados:

```bash
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wallet-events.fifo --max-number-of-messages 10
```

Como o consumidor se comporta:

- deduplica pela **inbox persistente** `(consumerName, messageId)`, na mesma transação SQL da alteração financeira;
- faz o ack **somente depois do commit**;
- trata os erros conforme o tipo:
  - **negócio:** ack;
  - **transitório:** retry com backoff exponencial;
  - **permanente:** DLQ;
  - tentativas esgotadas: DLQ.
- no `SIGTERM`, conclui as mensagens em andamento e devolve a visibilidade das que não começou.

---

## 5. Configuração

Todas as variáveis, com os valores padrão, estão em [.env.example](.env.example). As principais:

| Variável | Padrão | Descrição |
|---|---|---|
| `APP_ROLE` | `all` | `api` (só HTTP), `worker` (consumidor, outbox e pending reference, mais health) ou `all` |
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | conexão com o PostgreSQL |
| `DB_POOL_MAX` | `20` | conexões por instância |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima pelo lock da wallet; depois disso, o erro é tratado como transitório e a transação é refeita |
| `DB_TX_MAX_RETRIES` | `3` | quantas vezes uma transação é refeita após deadlock, lock timeout ou queda de conexão |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | endpoint do SQS (LocalStack) |
| `SQS_AUTO_CREATE` | `true` | cria as filas (e a redrive policy) na subida |
| `SQS_MAX_ATTEMPTS` | `5` | tentativas antes da DLQ |
| `SQS_CONSUMER_CONCURRENCY` | `2` | loops de consumo por instância |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | intervalo de polling do publisher |
| `OUTBOX_LEASE_MS` | `30000` | lease de um lote da outbox, recuperado se a instância morrer |
| `PENDING_REF_MAX_ATTEMPTS` | `10` | orçamento de espera por uma referência ausente (cerca de 13,5 min com o backoff padrão) |
| `SHUTDOWN_GRACE_MS` | `20000` | prazo para o desligamento gracioso |
| `LOG_LEVEL` | `info` | nível dos logs JSON |
| `OTEL_ENABLED` | `false` | liga o OpenTelemetry (OTLP/HTTP) |

Para ver os traces no Jaeger:

```bash
OTEL_ENABLED=true docker compose --profile otel up -d --build
```

### Rodar a aplicação fora do Docker

```bash
bun install
docker compose up -d postgres localstack
bun run migrate
bun run dev        # http://localhost:3000
```

Console em modo dev (o Vite faz proxy de `/api` para `localhost:8080`):

```bash
cd web && bun install && bun run dev
```

---

## 6. Testes

Os testes de integração e de concorrência usam **PostgreSQL e LocalStack reais**. Só os testes de unidade não dependem de infraestrutura.

```bash
bun install
docker compose up -d postgres localstack
```

| Comando | O que roda |
|---|---|
| `bun run test:unit` | domínio puro: `Money`, `Wallet`, ledger, regras de cada operação, transições de estado, hash de idempotência |
| `bun run test:integration` | migrations `up → down → up` e **cada constraint e trigger** testados com SQL direto; atomicidade; HTTP de ponta a ponta; SQS (inbox, replay, DLQ, retry); outbox; referências pendentes; Swagger |
| `bun run test:concurrency` | os 8 cenários obrigatórios, com paralelismo real: **3 processos independentes**, `SIGKILL` depois do commit e antes do ack, dois publishers, restart com consistência final |
| `bun test` | tudo |
| `bun run typecheck` / `bun run lint` | TypeScript estrito e ESLint |

Para rodar a suíte inteira **dentro do Linux** (recomendado no Windows, porque lá o teste de `SIGTERM` gracioso também roda):

```bash
docker compose --profile test run --rm tests
```

Resultado da última execução: **189 aprovados e 0 falhas no Linux**. No Windows são 188 aprovados e 1 ignorado, o `SIGTERM`, porque o Windows não entrega sinais POSIX. Todos os testes de integração e de concorrência terminam verificando a invariante `wallet.balance == saldo reconstruído pelo ledger`.

> Cada arquivo de teste recria o schema do banco `wagering_test` aplicando as migrations reais. Variáveis úteis: `TEST_DATABASE_URL`, `AWS_ENDPOINT_URL` e `TEST_LOG_LEVEL=debug`.

---

## 7. Teste de carga

Com o ambiente completo no ar:

```bash
DURATION_S=60 CONCURRENCY=50 bun run test:load
```

Execução de referência (notebook i5 de 4 núcleos, com tudo na mesma máquina):

| | |
|---|---|
| Throughput | **285 req/s**, 0% de erro, 0 conflitos de lock |
| Wallets frias | p50 18,7 ms · p99 117 ms |
| Hot wallet (20% do tráfego numa única wallet) | p50 416 ms (serializada pelo lock, como esperado) |
| Consistência | **201/201 wallets reconciliadas, 0 divergências**; 1.541 reenvios viraram replay |

A metodologia completa, o ambiente e a análise estão em [docs/LOAD_TEST.md](docs/LOAD_TEST.md).

---

## 8. Arquitetura em resumo

```
 Provedor ──HTTP──► nginx ──► app ×3 ──┐
 Provedor ──SQS───► wager-transactions.fifo ──► consumidor (em cada app) ──┤
                                                                           ▼
                          ProcessWagerTransactionUseCase (o mesmo para HTTP e SQS)
                                         │ 1 transação SQL
                                         ▼
          PostgreSQL: inbox · wager_transactions · wallets · ledger · outbox
                                         │ depois do COMMIT
                     outbox publisher (SKIP LOCKED + lease) ──► wallet-events.fifo
                     pending-reference worker (backoff) ──► resolve reversões fora de ordem
```

- **Idempotência persistente:** `INSERT … ON CONFLICT DO NOTHING` na `idempotency_key`. O `payloadHash` é o SHA-256 de um JSON canônico com as chaves ordenadas. Payload igual vira replay; payload diferente vira 409.
- **Concorrência:** um `SELECT … FOR NO KEY UPDATE` na linha da wallet serializa as alterações de saldo de cada wallet, sem lock global. Deadlocks e lock timeouts fazem a transação ser refeita, com limite de tentativas.
- **Banco como última garantia:** constraints e triggers garantem as uniques de idempotência e de reversão única, saldo e ledger nunca negativos, a aritmética e a cadeia do ledger, ledger append-only, transações terminais congeladas e `saldo == último lançamento` verificado **no COMMIT**.
- **`Money`:** representado como `bigint` em centavos, imutável e sem `number`. No banco, `numeric(20,2)` mais `char(3)`.
- **Domínio:** classes com construtor privado e factories `create`/`rehydrate`. Não depende de NestJS nem de MikroORM.

Os detalhes e as justificativas estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## 9. Estrutura do projeto

```
src/
  shared/          Money, erros, portas (UnitOfWork, Logger, Metrics), JSON canônico
  wallet/          domínio (Wallet, WalletLedgerEntry) e casos de uso (abrir, consultar, reconciliar)
  wagering/        domínio (WagerTransaction, regras, FailureCode) e casos de uso (processar, resolver pendências)
  messaging/       Inbox, Outbox, IntegrationEvent e eventos concretos
  infrastructure/  MikroORM, migration, repositórios SQL, SQS (consumidor, publisher, topologia), workers, health
  observability/   logs (pino), métricas (Prometheus), tracing (OpenTelemetry), contexto de correlação
  http/            NestJS: controllers, Swagger, filtro de erros, guard de autenticação (no-op)
  bootstrap/       composition root (Container)
  main.ts          entrada; o papel vem de APP_ROLE e há shutdown gracioso
web/               console de teste (Vite, React, Material UI, Tabler Icons)
test/
  unit/ integration/ concurrency/ load/ support/
docker/            init do Postgres e configuração do nginx
docs/              LOAD_TEST.md
ARCHITECTURE.md    decisões, trade-offs e limitações
CHALLENGE.md       enunciado original
PROMPT.md          prompt usado para guiar a implementação com IA (Claude Code)
PROGRESS.md        registro de progresso e dos bugs encontrados na validação
```

---

## 10. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `failed to connect to the docker API` | Docker Desktop fechado | abra o Docker Desktop e aguarde ele ficar "running" |
| O console mostra "API fora" | as réplicas ainda estão subindo | aguarde o `docker compose ps` mostrar `healthy` |
| `port is already allocated` (5432, 4566, 8080, 5173) | outro serviço está usando a porta | pare esse serviço ou altere a porta no `docker-compose.yml` |
| A LocalStack pede token de autenticação | versão nova da imagem | o projeto fixa `localstack/localstack:3.8.1`; não troque para `latest` |
| `400 INVALID_MONEY` | valor enviado sem as 2 casas decimais | envie `"25.00"`; o console já aplica a máscara |
| Testes de concorrência com timeout no Windows | máquina sobrecarregada | rode `docker compose --profile test run --rm tests` |
