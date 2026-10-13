CREATE TYPE "public"."audit_severity" AS ENUM('INFO', 'WARN', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('IN_PROGRESS', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('CREDIT', 'DEBIT');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('MONEY_RECEIVED', 'MONEY_SENT', 'PAYMENT_FAILED', 'REQUEST_RECEIVED', 'REQUEST_PAID', 'REQUEST_REJECTED', 'REQUEST_EXPIRED', 'WITHDRAWAL_UPDATE', 'SECURITY', 'ACCOUNT_STATUS', 'REPORT_READY', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PROCESSED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."payment_order_status" AS ENUM('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."payment_request_status" AS ENUM('PENDING', 'PAID', 'REJECTED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('ADD_MONEY', 'TRANSFER', 'WITHDRAWAL', 'REVERSAL');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('USER', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."wallet_status" AS ENUM('ACTIVE', 'FROZEN', 'CLOSED');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'USER' NOT NULL,
	"status" "user_status" DEFAULT 'PENDING_VERIFICATION' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"transaction_pin_hash" text,
	"pin_set_at" timestamp with time zone,
	"two_factor_secret" text,
	"daily_limit_override" bigint,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"is_system" boolean DEFAULT false NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"status" "wallet_status" DEFAULT 'ACTIVE' NOT NULL,
	"freeze_reason" text,
	"frozen_at" timestamp with time zone,
	"frozen_by" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_balance_non_negative" CHECK ("wallets"."balance" >= 0 OR "wallets"."is_system"),
	CONSTRAINT "wallets_owner_xor_system" CHECK (("wallets"."is_system" AND "wallets"."user_id" IS NULL) OR (NOT "wallets"."is_system" AND "wallets"."user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"endpoint" varchar(100) NOT NULL,
	"request_hash" char(64) NOT NULL,
	"status" "idempotency_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" "payment_order_status" DEFAULT 'CREATED' NOT NULL,
	"gateway_order_id" varchar(100) NOT NULL,
	"gateway_payment_id" varchar(100),
	"gateway_signature" text,
	"failure_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_orders_amount_positive" CHECK ("payment_orders"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"note" varchar(255),
	"status" "payment_request_status" DEFAULT 'PENDING' NOT NULL,
	"transaction_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_requests_amount_positive" CHECK ("payment_requests"."amount" > 0),
	CONSTRAINT "payment_requests_not_self" CHECK ("payment_requests"."requester_id" <> "payment_requests"."payer_id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" varchar(32) NOT NULL,
	"type" "transaction_type" NOT NULL,
	"status" "transaction_status" DEFAULT 'PENDING' NOT NULL,
	"amount" bigint NOT NULL,
	"fee" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"sender_wallet_id" uuid NOT NULL,
	"receiver_wallet_id" uuid NOT NULL,
	"initiated_by" uuid,
	"note" varchar(255),
	"reference_id" varchar(100),
	"payment_request_id" uuid,
	"payment_order_id" uuid,
	"reversal_of_transaction_id" uuid,
	"failure_code" varchar(50),
	"failure_reason" text,
	"idempotency_key_id" uuid,
	"request_id" varchar(64),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "transactions_amount_positive" CHECK ("transactions"."amount" > 0),
	CONSTRAINT "transactions_fee_non_negative" CHECK ("transactions"."fee" >= 0),
	CONSTRAINT "transactions_not_self" CHECK ("transactions"."sender_wallet_id" <> "transactions"."receiver_wallet_id"),
	CONSTRAINT "transactions_terminal_has_completed_at" CHECK ("transactions"."status" NOT IN ('SUCCESS','FAILED','CANCELLED') OR "transactions"."completed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"type" "ledger_entry_type" NOT NULL,
	"amount" bigint NOT NULL,
	"balance_before" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_amount_positive" CHECK ("ledger_entries"."amount" > 0),
	CONSTRAINT "ledger_balance_math" CHECK (("ledger_entries"."type" = 'CREDIT' AND "ledger_entries"."balance_after" = "ledger_entries"."balance_before" + "ledger_entries"."amount")
        OR ("ledger_entries"."type" = 'DEBIT' AND "ledger_entries"."balance_after" = "ledger_entries"."balance_before" - "ledger_entries"."amount"))
);
--> statement-breakpoint
CREATE TABLE "beneficiaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"beneficiary_user_id" uuid NOT NULL,
	"nickname" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "beneficiaries_not_self" CHECK ("beneficiaries"."owner_id" <> "beneficiaries"."beneficiary_user_id")
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_name" varchar(100) NOT NULL,
	"account_last4" varchar(4),
	"upi_id_masked" varchar(100),
	"ifsc" varchar(11),
	"is_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" varchar(150) NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email_money_received" boolean DEFAULT true NOT NULL,
	"email_money_sent" boolean DEFAULT true NOT NULL,
	"email_payment_requests" boolean DEFAULT true NOT NULL,
	"email_marketing" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"target_user_id" uuid,
	"action" varchar(80) NOT NULL,
	"severity" "audit_severity" DEFAULT 'INFO' NOT NULL,
	"entity_type" varchar(50),
	"entity_id" uuid,
	"ip_address" "inet",
	"user_agent" text,
	"request_id" varchar(64),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_info" text,
	"ip_address" "inet",
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"aggregate_type" varchar(50) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_frozen_by_users_id_fk" FOREIGN KEY ("frozen_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_payer_id_users_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_sender_wallet_id_wallets_id_fk" FOREIGN KEY ("sender_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_receiver_wallet_id_wallets_id_fk" FOREIGN KEY ("receiver_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_request_id_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."payment_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_order_id_payment_orders_id_fk" FOREIGN KEY ("payment_order_id") REFERENCES "public"."payment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reversal_of_transaction_id_transactions_id_fk" FOREIGN KEY ("reversal_of_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_idempotency_key_id_idempotency_keys_id_fk" FOREIGN KEY ("idempotency_key_id") REFERENCES "public"."idempotency_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beneficiaries" ADD CONSTRAINT "beneficiaries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beneficiaries" ADD CONSTRAINT "beneficiaries_beneficiary_user_id_users_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_status_created_idx" ON "users" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_user_id_uq" ON "wallets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_single_system_uq" ON "wallets" USING btree ("is_system") WHERE "wallets"."is_system";--> statement-breakpoint
CREATE INDEX "wallets_status_idx" ON "wallets" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_user_key_endpoint_uq" ON "idempotency_keys" USING btree ("user_id","key","endpoint");--> statement-breakpoint
CREATE INDEX "idempotency_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_gateway_order_uq" ON "payment_orders" USING btree ("gateway_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_gateway_payment_uq" ON "payment_orders" USING btree ("gateway_payment_id");--> statement-breakpoint
CREATE INDEX "payment_orders_user_created_idx" ON "payment_orders" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_orders_status_expires_idx" ON "payment_orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "payment_requests_payer_idx" ON "payment_requests" USING btree ("payer_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_requests_requester_idx" ON "payment_requests" USING btree ("requester_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_requests_pending_expiry_idx" ON "payment_requests" USING btree ("expires_at") WHERE "payment_requests"."status" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_public_id_uq" ON "transactions" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_reversal_of_uq" ON "transactions" USING btree ("reversal_of_transaction_id");--> statement-breakpoint
CREATE INDEX "transactions_sender_created_idx" ON "transactions" USING btree ("sender_wallet_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_receiver_created_idx" ON "transactions" USING btree ("receiver_wallet_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_status_created_idx" ON "transactions" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_type_created_idx" ON "transactions" USING btree ("type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_reference_idx" ON "transactions" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "transactions_payment_request_idx" ON "transactions" USING btree ("payment_request_id");--> statement-breakpoint
CREATE INDEX "transactions_payment_order_idx" ON "transactions" USING btree ("payment_order_id");--> statement-breakpoint
CREATE INDEX "transactions_inflight_idx" ON "transactions" USING btree ("created_at") WHERE "transactions"."status" IN ('PENDING','PROCESSING');--> statement-breakpoint
CREATE INDEX "transactions_note_trgm_idx" ON "transactions" USING gin ("note" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_txn_wallet_type_uq" ON "ledger_entries" USING btree ("transaction_id","wallet_id","type");--> statement-breakpoint
CREATE INDEX "ledger_wallet_created_idx" ON "ledger_entries" USING btree ("wallet_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ledger_transaction_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "beneficiaries_owner_beneficiary_uq" ON "beneficiaries" USING btree ("owner_id","beneficiary_user_id") WHERE "beneficiaries"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "beneficiaries_owner_idx" ON "beneficiaries" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "bank_accounts_user_idx" ON "bank_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."is_read" = false;--> statement-breakpoint
CREATE INDEX "audit_user_created_idx" ON "audit_logs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_action_created_idx" ON "audit_logs" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_severity_created_idx" ON "audit_logs" USING btree ("severity","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_target_created_idx" ON "audit_logs" USING btree ("target_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_uq" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_revoked_idx" ON "refresh_tokens" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("id") WHERE "outbox_events"."status" = 'PENDING';