-- Guards the Drizzle schema DSL cannot express: append-only tables, transaction state machine,
-- immutable core fields, and the double-entry balance invariant (deferred to COMMIT).

-- 1. Append-only tables: ledger_entries and audit_logs can never be updated or deleted.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- 2. Transaction state machine. Terminal states are immutable; only legal transitions allowed.
--    PENDING -> PROCESSING | FAILED | CANCELLED ; PROCESSING -> SUCCESS | FAILED
CREATE OR REPLACE FUNCTION guard_transaction_status() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('SUCCESS', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Transaction % is in terminal state %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status IN ('PROCESSING', 'FAILED', 'CANCELLED') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'PROCESSING' AND NEW.status IN ('SUCCESS', 'FAILED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Illegal transaction status transition % -> %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER transactions_status_guard
  BEFORE UPDATE OF status ON transactions
  FOR EACH ROW EXECUTE FUNCTION guard_transaction_status();
--> statement-breakpoint

-- Core financial fields of a transaction can never change after creation.
CREATE OR REPLACE FUNCTION guard_transaction_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.amount <> OLD.amount
     OR NEW.sender_wallet_id <> OLD.sender_wallet_id
     OR NEW.receiver_wallet_id <> OLD.receiver_wallet_id
     OR NEW.type <> OLD.type
     OR NEW.public_id <> OLD.public_id THEN
    RAISE EXCEPTION 'Core fields of transaction % are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER transactions_immutable_fields
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION guard_transaction_immutable();
--> statement-breakpoint

-- 3. Double-entry invariant: for every transaction, debits = credits.
--    Deferred, so it is evaluated at COMMIT after all entries of the transaction exist.
CREATE OR REPLACE FUNCTION assert_ledger_balanced() RETURNS trigger AS $$
DECLARE
  debits  bigint;
  credits bigint;
BEGIN
  SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'DEBIT'), 0),
         COALESCE(SUM(amount) FILTER (WHERE type = 'CREDIT'), 0)
    INTO debits, credits
    FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF debits <> credits THEN
    RAISE EXCEPTION 'Ledger not balanced for transaction %: debits=% credits=%',
      NEW.transaction_id, debits, credits
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();
