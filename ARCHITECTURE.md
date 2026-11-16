# ARCHITECTURE

Este documento explica as decisões técnicas, os trade-offs e as limitações conhecidas. O ponto de partida é que **o banco de dados é a fonte da verdade e o último guardião das invariantes**. O broker, a memória e a ordem de chegada das mensagens são tratados como otimização, nunca como garantia.

## 1. Visão geral

```
 Provedor ──HTTP──► [nginx] ──► app#1..#3  (NestJS: só a borda HTTP)
                                     │
 Provedor ──SQS──► wager-transactions.fifo ──► consumidor (em cada app)
                                     │
                                     ▼
                    ProcessWagerTransactionUseCase   ◄── o mesmo caso de uso para HTTP e SQS
                                     │  1 transação SQL
                                     ▼
            ┌──────── PostgreSQL ─────────────────────────────────┐
            │ inbox_messages │ wager_transactions │ wallets       │
            │ wallet_ledger_entries │ outbox_messages             │
            └──────────────────────────────────────────────────────┘
                                     │  depois do COMMIT
                    outbox publisher (em cada app, SKIP LOCKED + lease)
                                     ▼
                           wallet-events.fifo
     pending-reference worker (em cada app) ──► reprocessa PENDING_REFERENCE com backoff
```

As camadas, por módulo (`wallet`, `wagering`, `messaging`), são estas:

- **domain**: classes puras com construtor privado e factories `create`, `open`, `from` e `rehydrate`. Não há nenhum import de NestJS ou de MikroORM.
- **application**: casos de uso e portas (`UnitOfWork`, repositórios, `AppMetrics`, `Logger`).
- **infrastructure**: adaptadores (SQL e MikroORM, SQS, workers).
- **http**: controllers NestJS, que só fazem parse de entrada, chamam o caso de uso e mapeiam status.

O `Container` (`src/bootstrap/container.ts`) é o composition root, escrito em TypeScript puro. O NestJS recebe os objetos já montados, via `useValue`. Os testes usam o mesmo container, com Postgres e SQS reais.

**Topologia.** Há uma única imagem, e o papel de cada processo vem da variável `APP_ROLE`:

- `api`: só HTTP;
- `worker`: consumidor SQS, publisher da outbox e worker de referências pendentes, mais `/health` e `/metrics`;
- `all`: os dois.

O Compose sobe três réplicas com `all` atrás do nginx. Em produção, a ideia é escalar `api` e `worker` de forma independente.

## 2. ORM e estratégia transacional

**MikroORM 6** (o ORM preferencial do enunciado) cuida de três coisas:

1. o pool de conexões;
2. as transações, com `em.fork().transactional(cb, { isolationLevel })`;
3. as **migrations versionadas e reversíveis**: `Migrator` com `up`/`down` e lista explícita `migrationsList`, sem descoberta por glob, o que funciona igual no Bun, nos testes e no Docker.

**No caminho crítico, os repositórios usam SQL explícito** sobre o handle da transação que o MikroORM abre (`em.getTransactionContext()`). A decisão foi consciente, porque cada operação depende de uma construção SQL específica:

| Necessidade | Construção SQL |
|---|---|
| Reivindicar a idempotency key de forma atômica | `INSERT … ON CONFLICT DO NOTHING RETURNING` |
| Serializar as escritas por wallet | `SELECT … FOR NO KEY UPDATE` |
| Fazer N publishers da outbox trabalharem sem colisão | `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` |
| Garantir que o update de saldo case com a versão lida | `UPDATE … WHERE version = ?` |

O Unit of Work e o Identity Map do MikroORM foram feitos para agregados carregados, alterados e "flushados". Aqui, porém, a ordem exata das instruções faz parte da correção: primeiro o claim da chave, depois o lock, depois a decisão. Um flush automático que reordene ou agrupe writes, ou um Identity Map que devolva estado antigo depois de um `ON CONFLICT`, seriam riscos sem benefício. O que se mantém do UoW é o essencial, a **fronteira transacional única**: a porta `UnitOfWork.run()` entrega repositórios presos à mesma transação SQL, e tudo é confirmado junto ou nada é.

**Mapeamento do `Money`:**

- no banco: `numeric(20,2)` mais `char(3)`, em colunas separadas;
- na leitura: sempre `::text`, reidratado com `Money.rehydrate(string, currency)`;
- na escrita: `money.amount`, uma string, com `?::numeric`.

**Nenhum valor monetário passa por `number` em nenhuma camada.**

**Isolamento.** O nível é `READ COMMITTED` com locks explícitos. `SERIALIZABLE` não traria nada a mais, porque o lock da wallet já serializa o que importa, e criaria abortos por falso conflito sob carga. A reconciliação usa `REPEATABLE READ` para ler wallet e ledger no mesmo snapshot.

**Erros transitórios** fazem a transação inteira ser refeita do zero, até `DB_TX_MAX_RETRIES` vezes, com backoff e jitter. Contam como transitórios:

- `40001` (falha de serialização), `40P01` (deadlock) e `55P03` (lock timeout);
- `57014` (statement timeout);
- falhas de conexão;
- `23505` na única unique que pode colidir numa corrida (ver §4).

Erros de domínio e de negócio nunca são refeitos.

## 3. Concorrência

**A unidade de concorrência é a `walletId`, e a estratégia é lock pessimista.**

1. `INSERT` da transação, que reivindica a idempotency key. Uma chamada concorrente com a mesma chave **bloqueia no índice único** até a primeira terminar o commit e então cai no replay.
2. `SELECT … FROM wallets WHERE id = ? FOR NO KEY UPDATE`. Todas as alterações de saldo da mesma wallet passam por aqui, em qualquer instância, e wallets diferentes não se bloqueiam.

   **Por que `NO KEY UPDATE` e não `FOR UPDATE`:** o INSERT em `wager_transactions` tem FK para `wallets` e por isso pega `FOR KEY SHARE` na linha da wallet. Com `FOR UPDATE` (que conflita com `KEY SHARE`), duas transações que inseriram e depois pediram o lock esperavam uma pela outra: **deadlock**. Isso foi encontrado pelos testes de concorrência na validação. `FOR NO KEY UPDATE` continua exclusivo entre quem altera saldo, mas não conflita com `KEY SHARE`. É o mesmo lock que um `UPDATE` de colunas que não são chave pega.
3. Decisão de domínio sobre o estado já travado, com saldo, referência e verificação de "já revertida".
4. `UPDATE wallets … WHERE id = ? AND version = ?`. É defesa em profundidade: com o lock, nunca falha.
5. `SET LOCAL lock_timeout` e `statement_timeout` limitam a espera, para que uma hot wallet não consuma o pool indefinidamente.

**Por que pessimista.** Num cenário de hot wallet (muitas apostas na mesma carteira), o lock otimista degenera em retry storm: N−1 de N transações abortam a cada rodada. O lock pessimista forma uma fila FIFO no Postgres, com latência previsível e sem trabalho desperdiçado. O custo é a vazão por wallet ficar limitada a uma transação por vez, o que é aceitável: transações de uma mesma wallet precisam de ordem de qualquer jeito.

**Ordem de locks e ausência de deadlock.** O lock da linha da transação nova é sempre pego antes do lock da wallet. A atualização das transações pendentes da mesma wallet (`expediteDependents`) só acontece com o lock dessa wallet já obtido, e nenhuma transação trava duas wallets. Por isso não existe ciclo de espera.

**O banco garante a regra mesmo se o código falhar** (ver §4): `CHECK (balance_amount >= 0)` e os triggers de cadeia do ledger e de saldo igual ao ledger.

### Cenário obrigatório: saldo de 100,00 e duas apostas simultâneas de 80,00

As duas chaves são diferentes, então as duas transações conseguem fazer o INSERT. A segunda espera o `FOR NO KEY UPDATE` e só então enxerga o saldo de 20,00. O resultado é uma aposta `PROCESSED`, outra `REJECTED` com `INSUFFICIENT_FUNDS`, saldo final de 20,00 e um único DEBIT. Qualquer retry de qualquer uma das duas vira replay.

## 4. Schema: o que cada garantia do banco cobre

As constraints estão em `src/infrastructure/database/migrations/Migration20261116000000_initial_schema.ts`.

| Garantia | Onde |
|---|---|
| Uma wallet por `playerId` + `currency` | `uq_wallets_player_currency` |
| Saldo nunca negativo | `ck_wallets_balance_non_negative`, `ck_ledger_balance_*_non_negative`, `ck_wager_tx_result_balance_non_negative` |
| `version` ≥ 1, e incrementa em exatamente 1 **somente** quando o saldo muda | `ck_wallets_version_positive` e trigger `wallets_guard_update` |
| Idempotência persistente | `uq_wager_tx_idempotency_key`, `uq_wager_tx_provider_external` |
| No máximo um lançamento por transação e wallet | `uq_ledger_transaction_wallet` |
| O lançamento pertence à mesma wallet da transação | FK composta `fk_ledger_transaction_same_wallet` → `uq_wager_tx_id_wallet` |
| Aritmética do lançamento (`after = before ± amount`) | `ck_ledger_balanced` |
| Cadeia do ledger (`before[n] = after[n-1]`) | trigger `ledger_enforce_chain`, que também trava a wallet |
| Ledger imutável (append-only) | triggers que bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| Saldo materializado igual ao último `balance_after`, nos dois sentidos, verificado no COMMIT | constraint triggers `DEFERRABLE INITIALLY DEFERRED`: `wallet_matches_ledger` e `ledger_matches_wallet` |
| Transação terminal congelada; colunas de negócio imutáveis; nada é apagado | trigger `wager_tx_guard_update`; `DELETE` bloqueado |
| Referência uma única vez | índice único parcial `ux_wager_tx_single_reversal (reference_transaction_id) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Coerência de status: `PROCESSED` exige `processed_at` e saldo; `REJECTED`/`FAILED` exigem `failure_code`; `PENDING_REFERENCE` exige `next_attempt_at` | `ck_wager_tx_*_fields` |
| Domínio fechado de `kind`, `status`, `direction` e formato de moeda | `CHECK … IN (…)` e regex |
| Inbox: `(consumer_name, message_id)` único | `pk_inbox_messages` |

Índices parciais atendem os workers sem varrer as tabelas inteiras: `ix_outbox_pending_due`, `ix_wager_tx_pending_due` e `ix_wager_tx_awaiting_reference`. O cursor do ledger usa `seq` (identity), com o índice `(wallet_id, seq)`.

**A invariante "toda alteração de saldo tem lançamento, e vice-versa"** é garantida **no COMMIT** pelos dois constraint triggers diferidos. A invariante "version = 1 + nº de lançamentos que não são OPENING" é verificada pela reconciliação e pelos testes. Ela não virou trigger para não custar um `count(*)` por escrita.

## 5. Modelo de domínio

- **`Money`**: guarda o valor como `bigint` em centavos e é imutável (`Object.freeze`).
  - `from` é estrito na entrada: a regex `^(0|[1-9]\d{0,17})\.\d{2}$` rejeita `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas, negativos, sinal `+`, espaços, zeros à esquerda e valores fora de `numeric(20,2)`.
  - `rehydrate` aceita o que vem do banco, com sinal ou sem escala, como `"0"`.
  - **Não existe arredondamento**: entrada com mais de 2 casas é rejeitada, e a aritmética é exata. `"25"` e `"25.0"` são rejeitados porque o contrato exige escala fixa.
  - Operar duas moedas diferentes lança `CurrencyMismatchError`.
  - O modelo é multimoeda, mas o desafio usa só BRL.
- **`Wallet`** é o aggregate root. `debit` e `credit` devolvem a `WalletLedgerEntry` correspondente, e o lançamento é validado **antes** de o estado mudar. `open` com saldo positivo exige a transação `OPENING` e devolve o lançamento de abertura, mantendo `version` em 1 conforme o enunciado.
- **`WalletLedgerEntry`** só tem campos `readonly`, é congelada e não tem métodos de transição. `create` valida a aritmética.
- **`WagerTransaction`** tem a máquina de estados abaixo. Qualquer transição a partir de um estado terminal lança `InvalidTransactionStateError`, porque é erro de programação e não um caminho de negócio. O banco reforça isso com trigger.

```
PENDING ──► PROCESSED | REJECTED | FAILED            (terminais)
   └────► PENDING_REFERENCE ──(retry)──► PENDING_REFERENCE
                     └──────────────► PROCESSED | REJECTED | FAILED
```

`PENDING` só existe dentro da transação SQL de processamento e nunca é visível depois do commit.

- **`decideWager`** é uma função pura com as regras da seção 7. As checagens seguem esta ordem: dono e wallet, moeda, referência e, por fim, saldo.

## 6. Regras de negócio e interpretações adotadas

| Operação | Efeito | Ledger |
|---|---|---|
| BET | débito; `INSUFFICIENT_FUNDS` se não houver saldo | 1 DEBIT |
| WIN | crédito; pode referenciar opcionalmente a BET da mesma rodada | 1 CREDIT |
| LOSS | nenhum (`PROCESSED`); pode referenciar opcionalmente a BET | nenhum |
| REFUND | crédito; referencia só BET `PROCESSED`, com o mesmo valor | 1 CREDIT |
| ROLLBACK | inverso da referência (BET→CREDIT, WIN→DEBIT, REFUND→DEBIT), com o mesmo valor | 1 lançamento invertido |

Interpretações adotadas:

1. **Uma transação só pode ser revertida uma vez no total**, seja por REFUND ou por ROLLBACK. A regra é mais forte que "uma vez por tipo", porque REFUND e ROLLBACK da mesma BET creditariam o valor duas vezes e violariam "não duplicar créditos". O índice único parcial garante isso. Um ROLLBACK *de um REFUND* continua permitido, já que referencia outra transação.
2. A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ser do mesmo provider, player, wallet, moeda e rodada. Caso contrário, a operação recebe `REFERENCE_MISMATCH`.
3. Se a referência existe mas ainda está `PENDING_REFERENCE` (por exemplo, o ROLLBACK de um REFUND que espera a sua BET), a operação **também aguarda**.
4. Uma reversão que deixaria o saldo negativo recebe `REVERSAL_WOULD_OVERDRAW`, um código distinto de `INSUFFICIENT_FUNDS`. Ela é persistida e auditável.
5. Valor zero é inválido: toda transação externa precisa de `amount > 0`.
6. **Wallet inexistente** (`WALLET_NOT_FOUND`, HTTP 404) **não é persistida**, porque não há a quem vincular a transação. O efeito é naturalmente idempotente: nada muda.
7. **Erros de contrato não são persistidos.** É o caso de `OPENING` externo, `Money` inválido e REFUND sem referência, que retornam 400 ou vão para a DLQ: o payload nunca vai ser válido.
8. O `idempotencyKey` não é obrigado a seguir o formato `{providerId}:{externalTransactionId}`, que é só o padrão recomendado. Se a mesma `(providerId, externalTransactionId)` chegar com outra chave, a resposta é `EXTERNAL_ID_CONFLICT` (409).
9. O replay devolve o **resultado original**: status, `failureCode` e o saldo observado naquele momento, gravado em `result_balance_*`. Um replay de uma transação que estava `PENDING_REFERENCE` e já foi resolvida devolve o estado atual, que é o resultado definitivo.
10. O saldo observado é gravado na moeda **da wallet**. Por isso existe a coluna `result_balance_currency`, já que numa rejeição `CURRENCY_MISMATCH` a moeda do pedido é outra.

## 7. Idempotência

- O header `Idempotency-Key` (ou o campo `data.idempotencyKey` na fila) é a fonte da verdade e é **persistido** com a constraint única. Nada fica em memória.
- `payloadHash` é o SHA-256 em hexadecimal do **JSON canônico** do subconjunto de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e `referenceExternalTransactionId` (quando presente).
  - JSON canônico aqui significa chaves ordenadas recursivamente por code unit UTF-16, propriedades `undefined` omitidas e nenhum espaço (`src/shared/crypto/canonical-json.ts`).
  - O header, o correlation id, campos extras e o envelope SQS **não entram** no hash. A lista é explícita, por allow-list.
- Mesmo hash é **replay**: HTTP 200, ou 422 se a transação original foi rejeitada, com `idempotentReplay: true`.
- Hash diferente é **conflito**: HTTP 409 `IDEMPOTENCY_CONFLICT`. Não é replay.
- Duas requisições idênticas simultâneas: a segunda espera o índice único e cai no replay. O teste com 50 envios em paralelo comprova isso.

## 8. Mensageria

### Inbox (consumidor SQS)

O inbox é gravado com `INSERT … ON CONFLICT DO NOTHING` em `(consumer_name, message_id)` **na mesma transação** que a alteração financeira. Isso cobre dois casos de reentrega:

- **mesmo `messageId`**: o inbox detecta a duplicata e a mensagem recebe ack sem efeito;
- **`messageId` diferente com a mesma chave**: a idempotência da transação trata como replay.

Se o mesmo `messageId` chegar com conteúdo diferente, é `INBOX_PAYLOAD_MISMATCH` e a mensagem vai para a DLQ.

**O ack (`DeleteMessage`) acontece somente depois do commit.** Se o processo morrer entre o commit e o ack, a mensagem volta e o inbox a reconhece. Esse é o cenário 5, testado com um processo real que se mata com `SIGKILL`.

**Classificação de erros:**

| Classe | Exemplos | Ação |
|---|---|---|
| Negócio | `WALLET_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT`; rejeições como `INSUFFICIENT_FUNDS` são *resultado*, não erro | ack |
| Transitório | banco ou SQS indisponível, lock timeout, deadlock | `ChangeMessageVisibility` com backoff exponencial e jitter (`SQS_RETRY_BASE_SECONDS`, `SQS_RETRY_MAX_SECONDS`) |
| Permanente | JSON inválido, contrato inválido, `Money` inválido, `OPENING`, `INBOX_PAYLOAD_MISMATCH`, erro de programação | DLQ imediata |
| Desconhecido | — | tratado como transitório até `SQS_MAX_ATTEMPTS` (`ApproximateReceiveCount`); depois disso, DLQ com `MAX_ATTEMPTS_EXCEEDED` |

A **redrive policy nativa** usa `maxReceiveCount = SQS_MAX_ATTEMPTS + 2`. É uma rede de segurança para crash loops em que o consumidor nem chega a decidir.

**FIFO:** `MessageGroupId = walletId`. A ordem e a deduplicação do broker são **otimizações**. A correção vem do banco: os testes reenviam as mensagens com `MessageDeduplicationId` diferentes de propósito, para que o broker *entregue* as duplicatas.

**Heartbeat:** a visibilidade é estendida enquanto a mensagem está sendo processada.

**SIGTERM:** o consumidor para de fazer polling (aborta o long poll), espera as mensagens em andamento até `SHUTDOWN_GRACE_MS`, devolve a visibilidade (0) das que foram recebidas mas não começaram, encerra o HTTP e fecha os pools. Enquanto isso, `readiness` passa a responder 503 (`lifecycle: shutting down`). Se o prazo estourar, o que não teve ack volta para a fila depois do visibility timeout, sem perda.

### Transactional outbox

Os eventos são gravados em `outbox_messages` **na mesma transação** da alteração financeira. Nada é publicado antes do commit.

O publisher roda em todas as instâncias e funciona assim:

1. `claimDue`: um único `UPDATE … SET locked_by, locked_until = now()+lease WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n)`, sempre com o relógio do banco. Publishers concorrentes nunca pegam a mesma linha.
2. `SendMessageBatch` para `wallet-events.fifo`, com `MessageDeduplicationId = eventId` e `MessageGroupId = walletId` (o `partitionKey` do evento).
3. `markPublished` (`WHERE locked_by = owner`), ou `scheduleRetry` com backoff exponencial em caso de falha.

O cenário de crash funciona assim:

- Se a instância morre entre o commit e a publicação, a linha fica pendente e outra instância a publica.
- Se morre depois do claim, o **lease expira** e outra instância assume.
- Se morre depois de publicar e antes de marcar, a mensagem é republicada. A entrega é **at-least-once**: o FIFO descarta a duplicata dentro da janela de deduplicação de 5 minutos e, fora dela, **os consumidores deduplicam pelo `eventId`**, que é o contrato documentado do envelope.

O envelope é a classe abstrata `IntegrationEvent<T>`, com uma subclasse por evento. `eventType` e `version` ficam no tipo, e `data` só leva `MoneyProps` (strings).

Os eventos publicados são `WagerTransactionProcessed` (inclusive LOSS e OPENING), `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda), `WagerTransactionPendingReference` e, como extra, `WagerTransactionFailed`.

### Referências fora de ordem

Quando a referência ainda não existe, a transação é persistida como `PENDING_REFERENCE` (HTTP 202) e publica `WagerTransactionPendingReference`.

O worker agendado busca as transações vencidas (`next_attempt_at <= now()`), trava a wallet e relê a transação. Se `reference_attempts` mudou, outro worker já tratou aquela transação, e esta tentativa é descartada. Em seguida, reaplica **a mesma lógica** (`WagerSettlement`) do caminho síncrono.

**Backoff e TTL.** Os padrões são 10 tentativas, base de 2 s e teto de 5 min, o que dá uma janela de cerca de 13,5 minutos. Ela cobre com folga as janelas típicas de reentrega dos provedores sem deixar reversões abertas por tempo indeterminado. Esgotado o limite, a transação vira `REJECTED` com:

- `REFERENCE_NOT_FOUND`, se a referência nunca chegou;
- `REFERENCE_NOT_PROCESSED`, se a referência existe mas nunca foi processada.

Em seguida, o worker publica `WagerTransactionRejected`.

**Atalho.** Quando a transação referenciada é processada, as dependentes da mesma wallet têm o `next_attempt_at` antecipado para agora, na mesma transação SQL. O worker as resolve no próximo ciclo, sem esperar o backoff.

**`FAILED`.** Um erro inesperado e não transitório ao resolver uma pendência marca a transação como `FAILED` (`PROCESSING_ERROR`), em vez de entrar em loop infinito, e publica `WagerTransactionFailed`. A transação fica auditável.

## 9. Taxonomia de `failureCode`

Estes são os códigos persistidos em `REJECTED` e `FAILED`:

| Código | Quando | O que o provedor deve fazer |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | Desistir. Uma nova tentativa exige um novo `externalTransactionId` |
| `REVERSAL_WOULD_OVERDRAW` | ROLLBACK de WIN ou REFUND sem saldo | Desistir e acionar a operação. É caso de conciliação manual |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | Corrigir o payload e enviar com nova transação |
| `WALLET_PLAYER_MISMATCH` | o `playerId` não é o dono da `walletId` | Corrigir o payload |
| `REFERENCE_NOT_FOUND` | a referência não chegou dentro do TTL | Reenviar a referência e depois a reversão, com nova transação |
| `REFERENCE_NOT_PROCESSED` | a referência foi rejeitada ou falhou, ou não concluiu dentro do TTL | Desistir: não há o que reverter |
| `REFERENCE_MISMATCH` | a referência é de outro provider, player, wallet, moeda ou rodada | Corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | por exemplo, REFUND de um WIN, ou ROLLBACK de um LOSS | Corrigir o tipo da operação |
| `REFERENCE_AMOUNT_MISMATCH` | o valor difere do da referência (reversão parcial está fora do escopo) | Corrigir o valor |
| `ALREADY_REVERSED` | a referência já foi revertida | Nada a fazer: o efeito já existe |
| `PROCESSING_ERROR` (`FAILED`) | erro permanente inesperado | Acionar a operação. A transação fica auditável |

E estes são os códigos de erro da API, que não são persistidos:

`VALIDATION_ERROR`, `INVALID_MONEY`, `KIND_NOT_ALLOWED`, `REFERENCE_REQUIRED`, `INVALID_TRANSACTION`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_CURSOR`, `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT`, `WALLET_ALREADY_EXISTS`, `TRANSIENT_FAILURE`, `LOCK_CONFLICT` e `INTERNAL_ERROR`.

## 10. Mapeamento HTTP

O mapeamento é o mesmo em todos os endpoints, para que o provedor decida **pelo status**, sem precisar interpretar a mensagem de erro.

| Situação | Status | Reenviar? |
|---|---|---|
| Processada (primeira vez) | **201** | — |
| Replay idempotente | **200** (ou 422 se a original foi rejeitada) | — |
| Aceita, aguardando referência | **202** | Não. Consultar via GET |
| Payload inválido ou contrato quebrado | **400** | Não, sem corrigir antes |
| Recurso inexistente | **404** | Não |
| Conflito de idempotência ou unicidade | **409** | Não. É um bug do lado do provedor |
| Rejeição por regra de negócio (persistida, com `failureCode`) | **422** | Não com a mesma chave |
| Falha transitória de infraestrutura | **503** + `Retry-After` | **Sim, com a mesma chave** |
| Transação `FAILED` ou erro inesperado | **500** | Acionar a operação |

O corpo de erro é sempre `{ code, message, correlationId, details? }`. O corpo de um resultado é `{ transactionId, status, balance?, failureCode?, idempotentReplay }`.

## 11. Reconciliação

`POST /wallets/:id/reconciliation` roda num snapshot `REPEATABLE READ` e compara o saldo materializado com quatro verificações:

1. a soma de créditos menos débitos do ledger;
2. o `balance_after` do último lançamento;
3. a cadeia do ledger: o `balance_before` de cada lançamento igual ao `balance_after` anterior;
4. `version == 1 + nº de lançamentos que não são OPENING`.

**Nada é corrigido.** Uma divergência gera log `error` (sem valores), incrementa `wagering_reconciliations_total{result="divergent"}` e marca `consistent: false` com o detalhe em `checks`. Todos os testes de integração e concorrência terminam reconciliando todas as wallets.

## 12. Observabilidade

- **Logs:** JSON (pino), com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` vindos de `AsyncLocalStorage`, além de `instanceId`.
  - O correlation id vem do header `X-Correlation-Id`, ou é gerado e devolvido no header. No SQS, é o `messageId`.
  - Os logs não levam payloads nem valores. `money`, `balance`, `amount`, `payload`, `body` e `data` ainda passam por redaction, como proteção extra.
- **Métricas** (Prometheus, em `GET /metrics`, com label `instance`):

| Métrica | O que mede |
|---|---|
| `wagering_transactions_total{kind,status,source,replay}` | transações por status |
| `wagering_duplicates_detected_total{kind}` | duplicatas detectadas (`idempotent_replay`, `inbox_duplicate`) |
| `wagering_idempotency_conflicts_total` | conflitos de idempotência |
| `wagering_retries_total{component}` | retries |
| `wagering_dlq_messages_total{reason}` | mensagens enviadas para a DLQ |
| `wagering_sqs_messages_total{outcome}` | mensagens consumidas, por resultado |
| `wagering_lock_conflicts_total{reason}` | conflitos de lock |
| `wagering_outbox_pending`, `wagering_outbox_lag_seconds` | outbox lag (idade do evento pendente mais antigo) |
| `wagering_outbox_published_total`, `…_publish_failures_total` | publicações da outbox |
| `wagering_processing_duration_seconds` | latência de processamento (histograma) |
| `wagering_pending_reference_resolutions_total{outcome}` | resoluções de referências pendentes |
| `wagering_reconciliations_total{result}` | reconciliações e divergências |

- **Health:** `/health/live` só indica que o processo está vivo. `/health/ready` verifica Postgres (`SELECT 1`) e SQS (`GetQueueAttributes`) com timeout de 2 s, e responde 503 durante o shutdown. Nenhum dos dois exige autenticação.
- **OpenTelemetry** é opcional (`OTEL_ENABLED=true`): NodeSDK com exportador OTLP/HTTP para o Jaeger (`docker compose --profile otel`). Há spans manuais em `http.*`, `db.tx.*`, `sqs.consume.*` e `outbox.publish`, e o contexto W3C é propagado nos atributos das mensagens SQS.
  - **Limitação:** no Bun, as auto-instrumentações baseadas em hooks de `require` (http, pg) podem não aplicar os patches. Por isso os spans relevantes são criados manualmente.

## 13. Autenticação (não implementada, por decisão)

A autenticação não vale pontos, e o timebox foi para correção financeira e concorrência. O ponto de extensão está explícito:

- `ProviderIdentityPort` e `ProviderAuthGuard` (`src/http/auth/provider-auth.guard.ts`) estão aplicados nos controllers de wallets e wagering;
- o adapter atual é `TrustAllProviderIdentity`, um no-op;
- os endpoints de health e de métricas ficam abertos.

**O desenho que seria adotado:**

1. **Keycloak** no Compose, com um realm `wagering` e **um client confidencial por provedor** (fluxo `client_credentials`). Um mapper adicionaria a claim `provider_id` ao access token.
2. Um adapter `OidcProviderIdentity` validaria o JWT localmente: JWKS em cache e checagem de `iss`, `aud`, `exp` e `nbf`. Ele devolveria `{ subject, providerId }`.
3. O controller compararia `identity.providerId` com `payload.providerId` e responderia **403** `PROVIDER_MISMATCH` se fossem diferentes. Consultas por `/providers/:providerId/...` seriam restritas ao próprio provedor.
4. Na fila, que é um canal interno confiável, a identidade não seria revalidada. Mesmo assim, a identidade **contida na mensagem** continua passando pelas mesmas validações de domínio (dono da wallet, referência do mesmo provider etc.), e isso já está implementado.

## 14. Testes

| Suíte | O que cobre |
|---|---|
| `test/unit` | Money (escala, entradas inválidas, aritmética exata, moeda), invariantes da Wallet, imutabilidade do ledger, transições e regras de cada tipo, hash e conflito de payload, backoff, Inbox e Outbox |
| `test/integration` | Migrations `up → down → up` e **cada constraint e trigger** via SQL direto; atomicidade (falha logo antes do COMMIT não deixa nada); HTTP de ponta a ponta com todos os status; SQS (inbox, replay, erro de negócio, DLQ, retry transitório, esgotamento de tentativas); outbox (formato, dois publishers, expiração do lease, broker fora); referências pendentes (resolução, esgotamento, workers concorrentes) |
| `test/concurrency` | Os 8 cenários: 50× em paralelo; hot wallet (100/80/80 repetido; 200 apostas de 1,00 numa wallet de 150,00; tempestade mista); wallets distintas; **3 processos reais**; **SIGKILL depois do commit e antes do ack**; dois publishers em processos separados; referências fora de ordem em corrida; restart com crash no meio do tráfego e SIGTERM gracioso |

O paralelismo é real: cada chamada usa sua própria conexão, e os cenários de múltiplas instâncias rodam processos `bun src/main.ts` independentes. Não há mocks de Postgres nem de SQS fora dos testes de unidade. Os testes são determinísticos: não usam `sleep` arbitrário para esperar resultado, e sim `waitFor` com timeout.

## 15. Trade-offs e limitações conhecidas

- **Vazão por wallet:** o lock pessimista limita uma hot wallet a uma transação por vez, ao custo de cerca de 1 RTT de lock por operação. Para wallets extremamente quentes, uma opção seria um sub-ledger particionado com saldos parciais, mas isso fica fora do escopo.
- **SQL explícito em vez do UoW do MikroORM** no caminho crítico (ver §2). O custo é ter mappers manuais e o SQL acoplado ao Postgres. O ganho é controle total sobre `ON CONFLICT`, `FOR NO KEY UPDATE`, `SKIP LOCKED` e a ordem das instruções.
- **Outbox at-least-once:** dentro da janela do FIFO não há duplicata visível. Fora dela, os consumidores precisam deduplicar por `eventId`.
- **Polling da outbox:** a latência mínima de publicação fica perto de `OUTBOX_POLL_INTERVAL_MS`. `LISTEN/NOTIFY` reduziria isso, mas não foi implementado.
- **Testes no Windows:** o teste de `SIGTERM` gracioso é ignorado em `win32`, porque o Windows não entrega sinais POSIX. No Linux, com `docker compose --profile test run --rm tests`, ele roda.
- **LocalStack** está fixado na versão 3.8.1. Versões mais novas podem exigir token de autenticação.
- O inbox e a outbox não têm rotina de limpeza ou arquivamento. Em produção, seria um job de retenção por particionamento de data.
- **Vazão da hot wallet medida:** no teste de carga, as wallets frias ficaram com p99 de 117 ms e a hot wallet (cerca de 58 req/s numa só linha) com p50 de 416 ms. Detalhes em `docs/LOAD_TEST.md`.
- **Detalhes de driver descobertos na validação:** com o MikroORM, o `pg` devolve `timestamptz` como string (os mappers normalizam com `toDate`), e o knex **não** expande arrays em `IN (?)` (usa-se `= ANY(?::uuid[])`).
- **Double-entry** não foi implementado (é diferencial opcional). O ledger tem uma única perna por wallet.
