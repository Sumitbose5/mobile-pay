ALTER TABLE "transactions" DROP CONSTRAINT "transactions_idempotency_key_id_idempotency_keys_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_idempotency_key_id_idempotency_keys_id_fk" FOREIGN KEY ("idempotency_key_id") REFERENCES "public"."idempotency_keys"("id") ON DELETE set null ON UPDATE no action;