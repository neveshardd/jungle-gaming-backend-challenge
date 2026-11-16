# Prompt — Distributed Wagering Processor (Jungle Gaming)

> Cole este prompt no Claude Code com o diretório `D:\jungle.gaming\backend-challenge` aberto.
> O enunciado completo está em `CHALLENGE.md` — ele é a fonte da verdade. Este prompt fixa decisões, ordem de trabalho e critério de pronto.

---

## Papel e objetivo

Você é um engenheiro backend sênior especializado em sistemas financeiros distribuídos. Sua tarefa é implementar, do zero e de ponta a ponta, o desafio descrito em `CHALLENGE.md`: um serviço que processa transações de apostas (BET/WIN/LOSS/REFUND/ROLLBACK) vindas de HTTP e SQS, correto sob duplicação, fora de ordem, concorrência entre ≥3 instâncias e crashes.

Leia `CHALLENGE.md` inteiro antes de escrever qualquer código. Releia as seções relevantes no início de cada fase. A avaliação pesa, nesta ordem: correção financeira, concorrência, idempotência, mensageria/falhas, modelagem, testes, observabilidade, docs. Autenticação vale zero pontos — não gaste tempo nela além do ponto de extensão.

**Trabalhe de forma autônoma.** Execute todas as fases sem parar para pedir aprovação. Só pare se estiver genuinamente bloqueado (ex.: Docker indisponível). Diante de ambiguidade no enunciado, escolha a interpretação mais defensável, registre-a em `ARCHITECTURE.md` (seção "Interpretações adotadas") e siga em frente.

Mantenha um `PROGRESS.md` na raiz com: fase atual, o que está pronto, o que falta e decisões tomadas. Atualize ao fim de cada fase — ele serve para você retomar o contexto se a conversa for compactada.

---

## Decisões já tomadas (não reabra)

| Tema | Decisão |
|---|---|
| Runtime / PM / testes | Bun 1.x (`bun test`) |
| Linguagem | TypeScript `strict: true` (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` se viável) |
| Framework | NestJS |
| ORM | **MikroORM** (PostgreSQL driver) — `em.transactional()`, `LockMode.PESSIMISTIC_WRITE`, migrations com `up`/`down` |
| Banco | PostgreSQL 16 |
| Mensageria | AWS SQS via **LocalStack** (`@aws-sdk/client-sqs`) |
| Concorrência | **Pessimistic locking**: `SELECT ... FOR UPDATE` na linha da wallet dentro da transação SQL, **mais** constraints no schema como última linha de defesa (`CHECK balance >= 0`, uniques). Sem lock global; a unidade de lock é a `walletId`. |
| Autenticação | **Não implementar.** `AuthGuard` no-op + `ProviderIdentityPort` explícitos no código; desenho com Keycloak/OIDC (client credentials por provedor, claim `provider_id` validada contra `providerId` do payload) documentado no `ARCHITECTURE.md`. Health aberto. |
| Topologia | **Uma imagem, papéis por env**: `APP_ROLE=api|worker|all`. `api` = HTTP; `worker` = consumidor SQS + outbox publisher + pending-reference worker. Docker Compose sobe **3 réplicas** para provar multi-instância. |
| Diferenciais | **Teste de carga** (`bun run test:load`) e **OpenTelemetry** (traces HTTP → use case → DB → outbox → SQS, exportando para Jaeger no Compose, ligável por env). Ledger double-entry **não**. |
| Idioma | Código, identificadores, commits e comentários em **inglês**. `README.md` e `ARCHITECTURE.md` em **português**. |
| Git | `git init` na Fase 0. **Um commit convencional ao fim de cada fase**, só com testes passando (`feat:`, `test:`, `docs:`...). Nunca reescreva histórico. |

---

## Arquitetura alvo

Hexagonal / DDD leve, por módulo:

```
src/
  shared/            # Money, Clock, IdGenerator (UUIDv7), errors, Result, logger, metrics
  wallet/
    domain/          # Wallet, WalletLedgerEntry, erros — ZERO imports de NestJS/MikroORM
    application/     # use cases (OpenWallet, GetWallet, GetLedger, Reconcile), ports
    infrastructure/  # entidades/schemas MikroORM, mappers, repositórios
    http/            # controllers, DTOs, validação
  wagering/
    domain/          # WagerTransaction, enums, FailureCode, payload hash, regras
    application/     # ProcessWagerTransaction (usado por HTTP E SQS), ResolvePendingReferences
    infrastructure/
    http/
    messaging/       # consumidor SQS
  messaging/         # Inbox, Outbox, IntegrationEvent + subclasses, publisher worker
  health/
  observability/     # pino, prom-client, OTel
migrations/
test/
  unit/ integration/ concurrency/ load/
docker/              # init do LocalStack (filas), etc.
```

Regras de modelagem (seção 6.0): construtor `private`, factories `create`/`open`/`from` que validam e `rehydrate` que **não** revalida transições. Mapeamento ORM **fora do domínio** (persistence models/`EntitySchema` + mappers que chamam `rehydrate`). Domínio não conhece Nest nem MikroORM.

---

## Requisitos técnicos críticos

### Money
- Representação interna exata: `bigint` em unidades mínimas (centavos) **ou** `decimal.js` — escolha e justifique. **Nunca** `number` para valor monetário, em lugar nenhum (DTOs, colunas, eventos, métricas de valor, testes).
- Parse estrito por regex `^(0|[1-9]\d*)\.\d{2}$` nos contratos de entrada (escala fixa 2; rejeita NaN, Infinity, notação científica, vazio, >2 casas, negativos, sinal `+`, espaços). Documente se aceita `"25"` ou `"25.0"` (recomendo rejeitar: escala fixa).
- Serialização sempre `"25.00"`. Moeda ISO-4217 (3 letras maiúsculas). Operação entre moedas diferentes → `CurrencyMismatchError`.
- Coluna `numeric(20,2)` + `char(3)`. Garanta que o driver devolve `numeric` como **string** e que o mapper nunca passa por `number`.

### Schema (as garantias vivem no banco — restrição 9)
Projete com cuidado e teste cada constraint em integração. Mínimo esperado:

- `wallets`: `UNIQUE (player_id, currency)`, `CHECK (balance_amount >= 0)`, `CHECK (version >= 1)`.
- `wager_transactions`:
  - `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`;
  - `CHECK` de `kind` e `status` nos valores do enum; `CHECK (amount > 0)` (exceto se decidir que OPENING pode ser zero — não gere OPENING para saldo zero);
  - `CHECK` de que REFUND/ROLLBACK têm `reference_external_transaction_id`;
  - `CHECK` de coerência de status terminal (ex.: `PROCESSED ⇒ processed_at NOT NULL`, `REJECTED/FAILED ⇒ failure_code NOT NULL`);
  - **índice único parcial** que impede reverter a mesma referência duas vezes pelo mesmo tipo: `UNIQUE (reference_transaction_id, kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`;
  - snapshot do saldo observado no resultado (`result_balance_amount`) para que replay devolva o **saldo original** (regra 7.7), inclusive em REJECTED.
- `wallet_ledger_entries`:
  - `UNIQUE (transaction_id, wallet_id)` (no máximo um lançamento por transação/wallet);
  - `CHECK (amount > 0)`, `CHECK (balance_after >= 0)`;
  - `CHECK` aritmético: `(direction='CREDIT' AND balance_after = balance_before + amount) OR (direction='DEBIT' AND balance_after = balance_before - amount)`;
  - **imutabilidade no banco**: trigger que lança erro em `UPDATE`/`DELETE` (e `REVOKE` se usar role separada);
  - coluna `seq bigserial`/identity para cursor estável de paginação.
- `inbox_messages`: `PRIMARY KEY (consumer_name, message_id)` + `payload_hash`.
- `outbox_messages`: `published_at`, `attempts`, `next_attempt_at`, `locked_until`/`locked_by`; índice parcial em pendentes (`WHERE published_at IS NULL`).
- Considere também um invariante "toda alteração de saldo tem lançamento": ex. `wallets.version` = 1 + nº de lançamentos não-OPENING, verificado por reconciliação; documente o que é garantido por constraint e o que é verificado por reconciliação.
- Migrations versionadas e **reversíveis**; teste `up → down → up`.

### Fluxo transacional do `ProcessWagerTransaction` (único use case para HTTP e SQS)
Tudo em **uma** transação SQL (`READ COMMITTED` + locks explícitos; justifique o nível):
1. (SQS) inserir inbox `(consumer_name, message_id)` com `ON CONFLICT DO NOTHING`; se já existe → é duplicata: commit/ack sem efeito e métrica `duplicates_detected`.
2. Calcular `payloadHash` = SHA-256 de JSON canônico (chaves ordenadas recursivamente, sem header nem metadados de transporte) do subconjunto de campos de negócio. Documente exatamente quais campos e o algoritmo.
3. Inserir a transação com `ON CONFLICT (idempotency_key) DO NOTHING`. Se não inseriu: carregar a existente; hash igual → **replay** (resultado original, `idempotentReplay: true`); hash diferente → **conflito de idempotência** (não é replay). Trate também colisão em `(provider_id, external_transaction_id)` com chave diferente.
4. `SELECT ... FOR UPDATE` na wallet. Validar provider/player/wallet/moeda.
5. Para REFUND/ROLLBACK: resolver referência por `(provider_id, reference_external_transaction_id)` (lock na referência também, ordem de lock determinística para evitar deadlock); validar mesmo provider, player, wallet, moeda, rodada; tipo permitido; valor igual; não revertida antes. Ausente → `PENDING_REFERENCE`.
6. Aplicar no agregado `Wallet` (débito/crédito → nova `WalletLedgerEntry`, `version++`), persistir wallet + ledger.
7. Enfileirar na outbox os eventos (`WagerTransactionProcessed` | `Rejected` | `PendingReference` e `WalletBalanceChanged` só quando o saldo muda).
8. Commit. Só depois: ack (SQS) / resposta (HTTP). **Nada é publicado antes do commit.**

Serialization failures/deadlocks/lock timeouts → erro **transitório** com retry limitado e métrica `lock_conflicts`. Configure `lock_timeout`/`statement_timeout`.

### Regras de negócio
Siga a tabela da seção 7 e as regras 1–9 à risca. Em particular: LOSS é PROCESSED sem ledger e sem `WalletBalanceChanged`; reversão que deixaria saldo negativo é REJECTED com código **distinto** de `INSUFFICIENT_FUNDS`; OPENING não é aceito pela API/fila.

### Taxonomia de `failureCode` (ponto de partida — ajuste e documente)
`INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `CURRENCY_MISMATCH`, `WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH`, `REFERENCE_NOT_FOUND` (TTL esgotado), `REFERENCE_MISMATCH` (provider/player/wallet/rodada/moeda), `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_AMOUNT_MISMATCH`, `ALREADY_REVERSED`, `KIND_NOT_ALLOWED` (OPENING externo). Para cada um, documente: terminal?, o provedor deve reenviar/corrigir/desistir?

### Mapeamento HTTP (consistente em todos os endpoints; documente)
Sugestão:
- `400` payload inválido (validação de schema/Money), `404` recurso inexistente;
- `409` conflito de idempotência (mesma key, payload diferente) e wallet duplicada — com `code` distinto no corpo;
- `422` rejeição por regra de negócio (transação **persistida** como REJECTED, corpo traz `failureCode`, `transactionId`, `balance`);
- `201` processada; `200` replay (`idempotentReplay: true`, mesmo corpo do original — replay de REJECTED repete o 422);
- `202` aceita com processamento pendente (`PENDING_REFERENCE`);
- `503` + `Retry-After` falha transitória de infraestrutura.
Corpo de erro padronizado: `{ code, message, correlationId, details? }`. `Idempotency-Key` ausente → 400.

### SQS
- Filas no LocalStack via script de init: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive com `maxReceiveCount` configurável, ex. 5) e uma fila de eventos de saída (ex. `wallet-events.fifo`) para a outbox publicar. `MessageGroupId` = `walletId`; dedup do broker é só otimização.
- Consumidor: long polling, concorrência configurável, extensão de visibilidade (heartbeat) para mensagens longas; classificação de erro: **negócio** → ack; **transitório** → `ChangeMessageVisibility` com backoff exponencial + jitter; **permanente** (JSON malformado, schema inválido, tipo desconhecido) → enviar para DLQ explicitamente e ack (ou deixar estourar `maxReceiveCount` — escolha e justifique). Métricas de retries e DLQ.
- `SIGTERM`/`SIGINT`: parar polling, aguardar mensagens em andamento até um deadline, devolver visibilidade (`ChangeMessageVisibility 0`) das não iniciadas, fechar pool. Use `enableShutdownHooks()`.

### Outbox publisher
- Claim concorrente seguro: `SELECT ... FOR UPDATE SKIP LOCKED LIMIT n` com lease (`locked_until`) para sobreviver a crash entre claim e publish; publicar com `MessageDeduplicationId = eventId`; `markPublished` ou `scheduleRetry` (backoff exponencial com teto).
- At-least-once: consumidores downstream deduplicam por `eventId` — documente.
- Métrica de **outbox lag** (idade do evento pendente mais antigo) e pendentes.

### Pending-reference worker
- Agendado; reprocessa `PENDING_REFERENCE` com backoff exponencial (`attempts`, `next_attempt_at`), claim com `SKIP LOCKED`, reaproveitando a mesma lógica de domínio.
- Defina e justifique limite de tentativas/TTL; esgotado → `REJECTED` com `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.
- Otimização opcional: ao processar uma transação, disparar a resolução imediata das pendentes que a referenciam.

### Reconciliação
`POST /wallets/:walletId/reconciliation`: recalcula o saldo pelo ledger (soma de créditos − débitos e/ou `balance_after` do último lançamento, verificando a cadeia `balance_before[n] = balance_after[n-1]`), compara com o materializado, **não corrige**; loga em `warn` estruturado, incrementa métrica e sinaliza na resposta (formato da seção 9).

### Observabilidade
- `nestjs-pino`, JSON, com `correlationId` (header `X-Correlation-Id` ou gerado; em SQS, derivado do `messageId`), `messageId`, `transactionId`, `walletId`, `providerId`. **Sem** payload completo nem valores monetários nos logs (redaction configurada).
- `prom-client` em `GET /metrics`: transações por status/kind, duplicatas, retries, DLQ, lock conflicts, outbox lag/pendentes, latência de processamento (histograma), divergências de reconciliação.
- `GET /health/live` e `GET /health/ready` (Postgres `SELECT 1` + SQS `GetQueueUrl`), sem auth.
- OpenTelemetry: SDK Node com instrumentação HTTP/pg + spans manuais no use case, consumidor e publisher; propagar trace context no atributo da mensagem SQS. Verifique compatibilidade com Bun; se alguma auto-instrumentação não funcionar no Bun, use spans manuais e documente a limitação. Jaeger no Compose (`profile: otel`).

---

## Testes (sem mocks de Postgres/SQS fora dos testes de unidade)

- Unidade: tudo da seção 13 (Money: escala, arredondamento, entradas inválidas; invariantes da Wallet; regras de cada kind; conflito de moeda; key com payload divergente; transições de status e erro em estado terminal; `WalletLedgerEntry.create` rejeitando aritmética errada).
- Integração contra Postgres e LocalStack **reais** (Docker Compose de teste ou Testcontainers — valide que funciona com Bun no Windows/Docker Desktop; se Testcontainers der problema, use Compose com banco/filas isolados por suíte): migrations e cada constraint (inserts inválidos direto via SQL devem falhar; UPDATE/DELETE no ledger deve falhar), atomicidade wallet+ledger+inbox+outbox (injete falha antes do commit e verifique que nada persistiu), inbox/redelivery, publishers concorrentes, retry e DLQ, recuperação após reinício.
- Concorrência — os **8 cenários** da seção 13 com paralelismo real (`Promise.all` sobre conexões distintas e, para multi-instância, **processos separados** via `Bun.spawn`/Compose com 3 réplicas):
  1. mesma aposta 50× em paralelo → um débito;
  2. 100.00 BRL, duas apostas de 80.00 → 1 PROCESSED, 1 REJECTED `INSUFFICIENT_FUNDS`, saldo 20.00, 1 débito;
  3. wallets distintas em paralelo (e prova de que não se bloqueiam);
  4. ≥3 instâncias simultâneas;
  5. worker morto (`SIGKILL`) **depois do commit e antes do ack** → redelivery não duplica (use um ponto de injeção de falha controlado por env, só ativo em teste);
  6. dois publishers na mesma outbox → todo evento publicado, nenhum perdido;
  7. ROLLBACK/REFUND antes da referência → PENDING_REFERENCE e resolução posterior;
  8. reinício do serviço com consistência final comprovada.
- **Toda** suíte de integração/concorrência termina com a asserção `wallet.balance == saldo reconstruído pelo ledger` (helper compartilhado) e, quando aplicável, cadeia do ledger íntegra.
- Testes determinísticos: sem `sleep` arbitrário; use polling com timeout para condições assíncronas; `Clock` injetável.
- Scripts: `bun run test`, `test:unit`, `test:integration`, `test:concurrency`, `test:load`.

### Teste de carga (`bun run test:load`)
Script reprodutível (Bun ou k6 em container) contra o Compose com 3 réplicas: mix de BET/WIN/LOSS/REFUND/ROLLBACK, wallets frias e uma **hot wallet**, duplicatas propositais. Reporte em `docs/LOAD_TEST.md`: ambiente (máquina, Docker, versões), metodologia, throughput, p50/p95/p99, taxa de erro por classe, conflitos de lock, outbox lag máximo, e reconciliação de todas as wallets ao final. Seja honesto sobre gargalos — não há meta de RPS.

---

## Fases (commit ao fim de cada uma, com testes verdes)

0. **Fundação** — `git init`, `.gitignore`, Bun + Nest + TS strict, ESLint/Prettier, `docker-compose.yml` (postgres, localstack com init de filas, app com `APP_ROLE` e réplicas, jaeger em profile), `.env.example`, `Dockerfile`, scripts `package.json`. Smoke test de health.
1. **Domínio** — Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, IntegrationEvent + 4 subclasses, FailureCode, payload hash canônico. Testes de unidade completos.
2. **Persistência** — schemas MikroORM fora do domínio, mappers, migrations com todas as constraints/trigger, repositórios. Testes de integração das constraints e de `up/down`.
3. **Use cases + HTTP** — wallets (com OPENING), consultas, ledger com cursor opaco, `ProcessWagerTransaction`, idempotência, mapeamento HTTP, reconciliação, AuthGuard no-op. Testes de concorrência 1–3.
4. **SQS** — consumidor com inbox, classificação de erros, retry, DLQ, shutdown gracioso. Testes de inbox/redelivery/DLQ e cenário 5.
5. **Outbox + pending-reference worker** — publishers concorrentes, lease, backoff, TTL. Cenários 6 e 7.
6. **Multi-instância e recuperação** — cenários 4 e 8 com processos reais/3 réplicas.
7. **Observabilidade** — logs, métricas, OTel, readiness real.
8. **Carga** — `test:load` + `docs/LOAD_TEST.md`.
9. **Documentação** — `README.md` (pré-requisitos, setup, `docker compose up`, como rodar cada suíte, exemplos `curl`, variáveis de ambiente) e `ARCHITECTURE.md` (visão geral + diagrama, escolha do MikroORM e mapeamento de Money, estratégia transacional e de lock com justificativa, schema e o que cada constraint garante, idempotência e algoritmo de hash, máquina de estados da WagerTransaction, taxonomia de failureCode, mapeamento HTTP, inbox/outbox/DLQ, pending-reference TTL, autenticação não implementada + desenho, interpretações adotadas, trade-offs e limitações conhecidas).

---

## Proibido (eliminatório no enunciado)

- `number`/`float` para dinheiro em qualquer camada;
- idempotência dependente de memória/cache;
- confiar no FIFO/dedup do SQS como garantia;
- publicar evento antes do commit;
- UPDATE/DELETE em ledger;
- lock global; `read → calculate → update` sem lock;
- solução que só é correta com uma instância;
- testes que substituem Postgres/SQS por mocks (fora de unidade);
- marcar uma fase como pronta com testes falhando ou pulados — se algo não puder ser feito, registre em `PROGRESS.md` e na seção de limitações do `ARCHITECTURE.md`.

## Critério de pronto

- `docker compose up` sobe tudo com 3 réplicas e `/health/ready` verde;
- todas as suítes passam a partir de um clone limpo seguindo só o `README.md`;
- os 8 cenários de concorrência e o cenário da seção 8 passam de forma repetível (rode cada um várias vezes);
- reconciliação consistente em todas as wallets ao fim de todas as suítes e do teste de carga;
- histórico git com um commit por fase.

Ao terminar, entregue um resumo final: o que foi feito, como rodar, decisões principais, limitações e o que faria com mais tempo.
