import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Every guarantee of section 6 lives in the database, not only in code:
 *
 *  - uniqueness: wallet per (player_id, currency); transaction per idempotency_key and per
 *    (provider_id, external_transaction_id); one ledger line per (transaction, wallet);
 *    one PROCESSED reversal per referenced transaction (partial unique index);
 *  - non-negativity: wallet balance, ledger balances, result balance; positive amounts;
 *  - arithmetic: CHECK balance_after = balance_before ± amount;
 *  - immutability: triggers reject UPDATE/DELETE/TRUNCATE on the ledger, any change to a
 *    terminal transaction and any change to immutable transaction/wallet columns;
 *  - chain integrity: each ledger line must start where the previous one ended (trigger);
 *  - materialized balance == last ledger balance_after, checked at COMMIT (deferred
 *    constraint triggers on both tables) — a balance change without its ledger line, or a
 *    ledger line without the balance change, cannot be committed.
 *
 * NOTE: no '?' characters anywhere in this SQL (knex treats them as bindings).
 */
export class Migration20261116000000_initial_schema extends Migration {
  override async up(): Promise<void> {
    for (const statement of UP) this.addSql(statement);
  }

  override async down(): Promise<void> {
    for (const statement of DOWN) this.addSql(statement);
  }
}

const KINDS = `('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')`;
const STATUSES = `('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')`;

const UP: string[] = [
  // ---------------------------------------------------------------- wallets
  `CREATE TABLE wallets (
    id              uuid          PRIMARY KEY,
    player_id       varchar(128)  NOT NULL,
    currency        char(3)       NOT NULL,
    balance_amount  numeric(20,2) NOT NULL,
    version         integer       NOT NULL,
    created_at      timestamptz   NOT NULL,
    updated_at      timestamptz   NOT NULL,
    CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
    CONSTRAINT ck_wallets_balance_non_negative CHECK (balance_amount >= 0),
    CONSTRAINT ck_wallets_version_positive CHECK (version >= 1),
    CONSTRAINT ck_wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_wallets_player_not_empty CHECK (length(player_id) > 0)
  )`,

  // ---------------------------------------------------------------- wager transactions
  `CREATE TABLE wager_transactions (
    id                                uuid          PRIMARY KEY,
    provider_id                       varchar(128)  NOT NULL,
    external_transaction_id           varchar(128)  NOT NULL,
    idempotency_key                   varchar(256)  NOT NULL,
    payload_hash                      char(64)      NOT NULL,
    wallet_id                         uuid          NOT NULL REFERENCES wallets (id),
    player_id                         varchar(128)  NOT NULL,
    round_id                          varchar(128)  NOT NULL,
    game_id                           varchar(128)  NOT NULL,
    kind                              varchar(16)   NOT NULL,
    amount                            numeric(20,2) NOT NULL,
    currency                          char(3)       NOT NULL,
    reference_external_transaction_id varchar(128),
    reference_transaction_id          uuid          REFERENCES wager_transactions (id),
    status                            varchar(20)   NOT NULL,
    failure_code                      varchar(64),
    result_balance_amount             numeric(20,2),
    result_balance_currency           char(3),
    reference_attempts                integer       NOT NULL DEFAULT 0,
    next_attempt_at                   timestamptz,
    created_at                        timestamptz   NOT NULL,
    updated_at                        timestamptz   NOT NULL,
    processed_at                      timestamptz,
    CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
    CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
    CONSTRAINT uq_wager_tx_id_wallet UNIQUE (id, wallet_id),
    CONSTRAINT ck_wager_tx_kind CHECK (kind IN ${KINDS}),
    CONSTRAINT ck_wager_tx_status CHECK (status IN ${STATUSES}),
    CONSTRAINT ck_wager_tx_amount_positive CHECK (amount > 0),
    CONSTRAINT ck_wager_tx_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_wager_tx_payload_hash CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_wager_tx_reference_required CHECK (
      kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
    CONSTRAINT ck_wager_tx_no_self_reference CHECK (
      reference_external_transaction_id IS NULL OR reference_external_transaction_id <> external_transaction_id),
    CONSTRAINT ck_wager_tx_processed_fields CHECK (
      status <> 'PROCESSED' OR (processed_at IS NOT NULL AND failure_code IS NULL AND result_balance_amount IS NOT NULL)),
    CONSTRAINT ck_wager_tx_reversal_bound CHECK (
      status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL),
    CONSTRAINT ck_wager_tx_failure_fields CHECK (
      (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
    CONSTRAINT ck_wager_tx_pending_reference_fields CHECK (
      status <> 'PENDING_REFERENCE' OR (next_attempt_at IS NOT NULL AND reference_external_transaction_id IS NOT NULL)),
    CONSTRAINT ck_wager_tx_result_balance_non_negative CHECK (result_balance_amount IS NULL OR result_balance_amount >= 0),
    CONSTRAINT ck_wager_tx_result_balance_pair CHECK ((result_balance_amount IS NULL) = (result_balance_currency IS NULL)),
    CONSTRAINT ck_wager_tx_attempts_non_negative CHECK (reference_attempts >= 0)
  )`,
  // A referenced transaction can be reversed (REFUND or ROLLBACK) at most once.
  `CREATE UNIQUE INDEX ux_wager_tx_single_reversal ON wager_transactions (reference_transaction_id)
     WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`,
  `CREATE INDEX ix_wager_tx_pending_due ON wager_transactions (next_attempt_at)
     WHERE status = 'PENDING_REFERENCE'`,
  `CREATE INDEX ix_wager_tx_awaiting_reference ON wager_transactions (wallet_id, provider_id, reference_external_transaction_id)
     WHERE status = 'PENDING_REFERENCE'`,
  `CREATE INDEX ix_wager_tx_wallet_created ON wager_transactions (wallet_id, created_at)`,

  // ---------------------------------------------------------------- ledger
  `CREATE TABLE wallet_ledger_entries (
    id              uuid          PRIMARY KEY,
    seq             bigint        GENERATED ALWAYS AS IDENTITY,
    wallet_id       uuid          NOT NULL REFERENCES wallets (id),
    transaction_id  uuid          NOT NULL,
    direction       varchar(6)    NOT NULL,
    amount          numeric(20,2) NOT NULL,
    currency        char(3)       NOT NULL,
    balance_before  numeric(20,2) NOT NULL,
    balance_after   numeric(20,2) NOT NULL,
    created_at      timestamptz   NOT NULL,
    CONSTRAINT uq_ledger_seq UNIQUE (seq),
    CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
    CONSTRAINT fk_ledger_transaction_same_wallet FOREIGN KEY (transaction_id, wallet_id)
      REFERENCES wager_transactions (id, wallet_id),
    CONSTRAINT ck_ledger_direction CHECK (direction IN ('DEBIT','CREDIT')),
    CONSTRAINT ck_ledger_amount_positive CHECK (amount > 0),
    CONSTRAINT ck_ledger_balance_before_non_negative CHECK (balance_before >= 0),
    CONSTRAINT ck_ledger_balance_after_non_negative CHECK (balance_after >= 0),
    CONSTRAINT ck_ledger_balanced CHECK (
      (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
      (direction = 'DEBIT'  AND balance_after = balance_before - amount))
  )`,
  `CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq)`,

  // ---------------------------------------------------------------- inbox / outbox
  `CREATE TABLE inbox_messages (
    consumer_name varchar(128) NOT NULL,
    message_id    varchar(256) NOT NULL,
    payload_hash  char(64)     NOT NULL,
    received_at   timestamptz  NOT NULL,
    processed_at  timestamptz,
    CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
  )`,
  `CREATE TABLE outbox_messages (
    id              uuid          PRIMARY KEY,
    aggregate_id    varchar(128)  NOT NULL,
    partition_key   varchar(128)  NOT NULL,
    event_type      varchar(128)  NOT NULL,
    payload         jsonb         NOT NULL,
    occurred_at     timestamptz   NOT NULL,
    attempts        integer       NOT NULL DEFAULT 0,
    next_attempt_at timestamptz   NOT NULL,
    published_at    timestamptz,
    locked_until    timestamptz,
    locked_by       varchar(128),
    last_error      varchar(1024),
    CONSTRAINT ck_outbox_attempts_non_negative CHECK (attempts >= 0)
  )`,
  `CREATE INDEX ix_outbox_pending_due ON outbox_messages (next_attempt_at, occurred_at) WHERE published_at IS NULL`,

  // ---------------------------------------------------------------- triggers
  `CREATE FUNCTION reject_modification() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
     RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
       USING ERRCODE = 'restrict_violation';
   END
   $fn$`,
  `CREATE TRIGGER trg_ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
     FOR EACH ROW EXECUTE FUNCTION reject_modification()`,
  `CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
     FOR EACH STATEMENT EXECUTE FUNCTION reject_modification()`,
  `CREATE TRIGGER trg_wager_tx_no_delete BEFORE DELETE ON wager_transactions
     FOR EACH ROW EXECUTE FUNCTION reject_modification()`,
  `CREATE TRIGGER trg_wallets_no_delete BEFORE DELETE ON wallets
     FOR EACH ROW EXECUTE FUNCTION reject_modification()`,

  // Terminal transactions are frozen; business columns are immutable in every state.
  `CREATE FUNCTION wager_tx_guard_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
     IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
       RAISE EXCEPTION 'wager transaction % is terminal (%) and cannot change', OLD.id, OLD.status
         USING ERRCODE = 'restrict_violation';
     END IF;
     IF NEW.id <> OLD.id OR NEW.provider_id <> OLD.provider_id
        OR NEW.external_transaction_id <> OLD.external_transaction_id
        OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.payload_hash <> OLD.payload_hash
        OR NEW.wallet_id <> OLD.wallet_id OR NEW.player_id <> OLD.player_id
        OR NEW.round_id <> OLD.round_id OR NEW.game_id <> OLD.game_id
        OR NEW.kind <> OLD.kind OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
        OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
        OR NEW.created_at <> OLD.created_at THEN
       RAISE EXCEPTION 'immutable columns of wager transaction % cannot change', OLD.id
         USING ERRCODE = 'restrict_violation';
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `CREATE TRIGGER trg_wager_tx_guard_update BEFORE UPDATE ON wager_transactions
     FOR EACH ROW EXECUTE FUNCTION wager_tx_guard_update()`,

  `CREATE FUNCTION wallets_guard_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
     IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
        OR NEW.created_at <> OLD.created_at THEN
       RAISE EXCEPTION 'immutable columns of wallet % cannot change', OLD.id USING ERRCODE = 'restrict_violation';
     END IF;
     IF NEW.balance_amount <> OLD.balance_amount AND NEW.version <> OLD.version + 1 THEN
       RAISE EXCEPTION 'wallet % balance change must increment version by exactly 1', OLD.id
         USING ERRCODE = 'check_violation';
     END IF;
     IF NEW.balance_amount = OLD.balance_amount AND NEW.version <> OLD.version THEN
       RAISE EXCEPTION 'wallet % version may only change with the balance', OLD.id USING ERRCODE = 'check_violation';
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `CREATE TRIGGER trg_wallets_guard_update BEFORE UPDATE ON wallets
     FOR EACH ROW EXECUTE FUNCTION wallets_guard_update()`,

  // Ledger chain: lock the wallet row, then require balance_before == previous balance_after.
  `CREATE FUNCTION ledger_enforce_chain() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE
     wallet_currency char(3);
     previous_after numeric(20,2);
   BEGIN
     SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id FOR NO KEY UPDATE;
     IF wallet_currency IS DISTINCT FROM NEW.currency THEN
       RAISE EXCEPTION 'ledger currency % differs from wallet currency %', NEW.currency, wallet_currency
         USING ERRCODE = 'check_violation';
     END IF;
     SELECT balance_after INTO previous_after FROM wallet_ledger_entries
       WHERE wallet_id = NEW.wallet_id ORDER BY seq DESC LIMIT 1;
     IF NEW.balance_before <> COALESCE(previous_after, 0) THEN
       RAISE EXCEPTION 'ledger chain broken for wallet %: expected balance_before %, got %',
         NEW.wallet_id, COALESCE(previous_after, 0), NEW.balance_before USING ERRCODE = 'check_violation';
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `CREATE TRIGGER trg_ledger_enforce_chain BEFORE INSERT ON wallet_ledger_entries
     FOR EACH ROW EXECUTE FUNCTION ledger_enforce_chain()`,

  // At COMMIT: the materialized balance must equal the last ledger balance (0 without entries).
  `CREATE FUNCTION wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE
     current_balance numeric(20,2);
     ledger_balance numeric(20,2);
   BEGIN
     SELECT balance_amount INTO current_balance FROM wallets WHERE id = NEW.id;
     SELECT balance_after INTO ledger_balance FROM wallet_ledger_entries
       WHERE wallet_id = NEW.id ORDER BY seq DESC LIMIT 1;
     IF current_balance <> COALESCE(ledger_balance, 0) THEN
       RAISE EXCEPTION 'wallet % balance % does not match ledger balance %',
         NEW.id, current_balance, COALESCE(ledger_balance, 0) USING ERRCODE = 'check_violation';
     END IF;
     RETURN NULL;
   END
   $fn$`,
  `CREATE CONSTRAINT TRIGGER trg_wallet_matches_ledger AFTER INSERT OR UPDATE ON wallets
     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_matches_ledger()`,

  // ...and vice versa: a ledger line cannot be committed without the matching wallet balance.
  `CREATE FUNCTION ledger_matches_wallet() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE
     current_balance numeric(20,2);
     ledger_balance numeric(20,2);
   BEGIN
     SELECT balance_amount INTO current_balance FROM wallets WHERE id = NEW.wallet_id;
     SELECT balance_after INTO ledger_balance FROM wallet_ledger_entries
       WHERE wallet_id = NEW.wallet_id ORDER BY seq DESC LIMIT 1;
     IF current_balance <> COALESCE(ledger_balance, 0) THEN
       RAISE EXCEPTION 'ledger balance % of wallet % does not match wallet balance %',
         COALESCE(ledger_balance, 0), NEW.wallet_id, current_balance USING ERRCODE = 'check_violation';
     END IF;
     RETURN NULL;
   END
   $fn$`,
  `CREATE CONSTRAINT TRIGGER trg_ledger_matches_wallet AFTER INSERT ON wallet_ledger_entries
     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_matches_wallet()`,
];

const DOWN: string[] = [
  `DROP TABLE IF EXISTS outbox_messages`,
  `DROP TABLE IF EXISTS inbox_messages`,
  `DROP TABLE IF EXISTS wallet_ledger_entries`,
  `DROP TABLE IF EXISTS wager_transactions`,
  `DROP TABLE IF EXISTS wallets`,
  `DROP FUNCTION IF EXISTS ledger_matches_wallet()`,
  `DROP FUNCTION IF EXISTS wallet_matches_ledger()`,
  `DROP FUNCTION IF EXISTS ledger_enforce_chain()`,
  `DROP FUNCTION IF EXISTS wallets_guard_update()`,
  `DROP FUNCTION IF EXISTS wager_tx_guard_update()`,
  `DROP FUNCTION IF EXISTS reject_modification()`,
];
