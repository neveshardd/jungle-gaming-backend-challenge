# Teste de carga

Os resultados abaixo vêm de uma execução real. O JSON completo está em `test/load/results/` (esse diretório fica fora do git; os números foram copiados para cá).

## Como rodar

```bash
docker compose up -d --build                 # 3 réplicas atrás do nginx (:8080)
DURATION_S=60 CONCURRENCY=50 WALLETS=200 bun run test:load
```

Parâmetros (variáveis de ambiente):

- `BASE_URL`: padrão `http://localhost:8080`;
- `DATABASE_URL`: usado para medir o outbox lag direto na tabela;
- `DURATION_S`, `CONCURRENCY`, `WALLETS`;
- `DUPLICATE_RATIO`: padrão 0.1.

## Metodologia

- **Modelo fechado:** `CONCURRENCY` usuários virtuais, cada um enviando a próxima requisição assim que recebe a anterior, durante `DURATION_S` segundos.
- **Mistura de operações:**

| Fatia | Operação |
|---|---|
| 60% | BET em wallets frias |
| 15% | WIN ou LOSS em wallets frias |
| 5% | REFUND ou ROLLBACK de BETs já processadas (exercita a resolução de referência) |
| 20% | BET de 0,01 numa **única hot wallet**, para provocar contenção de lock |

- **Duplicatas:** depois de cada requisição, com probabilidade `DUPLICATE_RATIO`, a mesma requisição é reenviada com a mesma chave. Ela tem que virar replay, nunca um segundo efeito.
- **Latência:** é medida no cliente, por requisição, de ponta a ponta, passando pelo nginx. Calculei os percentis no total e separados por grupo (hot wallet e wallets frias).
- **Erros:** `transient` (503), `server_error` (5xx) e `network` (falha de conexão) contam como erro. 422 (rejeição de negócio) e 409 são resultados esperados e não contam.
- **Conflitos de lock:** soma, por instância, de `wagering_lock_conflicts_total`. O script raspa `/metrics` várias vezes pelo balanceador para enxergar as três réplicas.
- **Outbox:**
  - pendentes e lag (idade do evento não publicado mais antigo), amostrados a cada 1 s direto no Postgres;
  - tempo de drenagem depois do fim da carga;
  - percentis de `published_at − occurred_at`.
- **Correção:** no fim, o script chama `POST /wallets/:id/reconciliation` em **todas** as wallets, e o teste falha (exit 1) se alguma estiver inconsistente.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | notebook com Intel Core i5-11300H (4 núcleos / 8 threads), 32 GB de RAM |
| SO | Windows 11 Home, Docker Desktop 29.9.3 (WSL2, 8 CPUs e 15,5 GB para a VM) |
| Bun | 1.4.4 (no cliente e nas réplicas) |
| Topologia | 3 × `app` (`APP_ROLE=all`, pool de 20 conexões cada), PostgreSQL 16.4, LocalStack 3.8.1, nginx 1.27 |
| Cliente | o próprio script, na **mesma máquina** que todo o stack |

## Resultados

Execução de 60 s, 50 usuários virtuais, 200 wallets frias e 1 hot wallet, 10% de duplicatas:

| Métrica | Valor |
|---|---|
| Requisições | 17.256 (15.715 processadas + 1.541 replays idempotentes) |
| Throughput | **285 req/s** |
| Latência total p50 / p95 / p99 / máx. | 21,5 / 1.104 / 2.736 / 8.765 ms |
| Wallets frias (13.778 req) p50 / p95 / p99 / máx. | **18,7 / 64,0 / 117,4 / 265** ms |
| Hot wallet (3.478 req) p50 / p95 / p99 / máx. | **415,8 / 2.733 / 4.368 / 8.765** ms |
| Taxa de erro | **0%** (nenhum 5xx, 503 ou falha de rede) |
| Conflitos de lock (deadlock, timeout, serialização) | **0** |
| Outbox: pendentes no pico | 467 |
| Outbox: lag máximo durante a carga | 8,8 s |
| Outbox: publicação p50 / p95 / p99 | 372 / 1.416 / 3.033 ms |
| Outbox: drenagem depois do fim da carga | 0,5 s |
| Reconciliação | **201 wallets verificadas, 0 inconsistentes** |

Uma execução anterior, idêntica, deu números praticamente iguais: 285,9 req/s, p99 de 2.666 ms, 0 erros e 0 inconsistências.

## Análise

1. **A correção se manteve sob carga.** Houve 1.541 reenvios com a mesma chave, todos viraram replay, e nenhuma wallet terminou inconsistente com o ledger. Também não houve erro nem conflito de lock: o `lock_timeout` de 5 s nunca disparou, nem com 20% do tráfego numa única linha.
2. **A cauda é inteiramente da hot wallet, e isso é esperado.** As wallets frias ficam com p99 de 117 ms. A hot wallet recebe cerca de 58 req/s, que são serializados pelo `FOR NO KEY UPDATE`. Cada transação segura o lock por alguns milissegundos (o tempo das instruções restantes mais o COMMIT), e cerca de 10 usuários virtuais disputam a mesma linha a qualquer momento. A fila resultante explica o p50 de 416 ms.
   Esse é o custo escolhido conscientemente pelo lock pessimista (ARCHITECTURE.md §3): latência previsível e nenhum trabalho perdido, em troca de vazão limitada por wallet. Com locking otimista, as mesmas 58 req/s gerariam aborts e retries em cascata.
   Se uma única wallet precisasse de vazão maior, as saídas seriam:
   - reduzir o tempo com o lock (por exemplo, inserir a transação e o ledger numa única ida ao banco);
   - particionar o saldo da wallet em sub-saldos.
3. **A outbox é o próximo gargalo.** O publisher de cada instância processa lotes de 50 com chamadas `SendMessageBatch` sequenciais, a cada 500 ms. A cerca de 500 eventos/s, o lag chegou a 8,8 s em picos, mas se manteve limitado: a fila drenou em 0,5 s depois do fim da carga e nada se perdeu.
   Melhorias diretas, não implementadas:
   - publicar os chunks de 10 em paralelo;
   - lotes maiores quando o anterior veio cheio;
   - `LISTEN/NOTIFY` para acordar o publisher sem polling.
4. **Ressalvas:**
   - O cliente, as 3 réplicas, o Postgres e o LocalStack dividem os mesmos 4 núcleos físicos, e o LocalStack não tem as características de latência do SQS real.
   - Os números absolutos servem de linha de base local, não de capacidade de produção. O que o experimento mostra com segurança é: zero inconsistências, zero erros, a diferença entre hot e cold, e que a outbox acompanha a carga sem perda.
