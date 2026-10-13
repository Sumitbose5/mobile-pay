DROP INDEX "transactions_sender_created_idx";--> statement-breakpoint
DROP INDEX "transactions_receiver_created_idx";--> statement-breakpoint
CREATE INDEX "transactions_sender_created_idx" ON "transactions" USING btree ("sender_wallet_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "transactions_receiver_created_idx" ON "transactions" USING btree ("receiver_wallet_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);