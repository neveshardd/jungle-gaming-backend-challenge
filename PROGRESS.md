# PROGRESS

## Estado atual

Todas as fases estão implementadas e **validadas com execução real** em 16/11/2026.

| Verificação | Resultado |
|---|---|
| `bun run typecheck` | sem erros |
| `bun test` no Windows (Postgres e LocalStack reais) | 188 pass, 1 skip (o `SIGTERM` gracioso é pulado em win32), 0 fail |
| `docker compose --profile test run --rm tests` (Linux) | **189 pass, 0 fail**, incluindo o `SIGTERM` gracioso |
| `docker compose up -d --build` (3 réplicas + nginx) | healthy; smoke via HTTP e via SQS ok |
| `bun run test:load` (60 s, 50 VUs) | 285 req/s, 0% de erro, 0 conflitos de lock, 201/201 wallets consistentes |

## Bugs encontrados e corrigidos na validação

1. **Deadlock entre o lock da wallet e a FK.** O `FOR UPDATE` conflitava com o `FOR KEY SHARE` que o INSERT com FK pega. O lock passou a ser `FOR NO KEY UPDATE`, no repositório e no trigger de cadeia do ledger.
2. **Timestamps como string.** O MikroORM registra parsers no `pg` que devolvem `timestamptz` como string. Os mappers agora normalizam com `toDate` e `toOptionalDate`.
3. **Arrays em `IN (?)`.** O knex não expande arrays nessa forma, e o `markPublished` da outbox falhava. A consulta passou a usar `= ANY(?::uuid[])`.
4. **`CreateQueue` com atributos divergentes.** A chamada falhava quando a fila já existia com outro `VisibilityTimeout`. Agora a aplicação reutiliza a fila existente.
5. **Dependência faltando.** O `ajv` 8 não estava declarado, mas é peer dependency das migrations (o ESLint puxava o v6 para a raiz).
6. **Testes.** Corrigi um filtro de contagem no cenário 8, a tipagem de alguns helpers e o helper de processo, que agora falha rápido quando o processo morre no startup.

## Pendências e possíveis melhorias

- Publisher da outbox mais rápido: chunks em paralelo ou `LISTEN/NOTIFY`. O lag chegou a 8,8 s em pico, sem perda.
- Autenticação com Keycloak: o desenho está documentado em ARCHITECTURE.md §13.
- Retenção para inbox e outbox.
