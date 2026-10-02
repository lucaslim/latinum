CREATE TYPE "public"."leg_kind" AS ENUM('put', 'call', 'stock');--> statement-breakpoint
CREATE TYPE "public"."position_role" AS ENUM('income', 'hedge', 'swing');--> statement-breakpoint
CREATE TYPE "public"."side" AS ENUM('long', 'short');--> statement-breakpoint
CREATE TYPE "public"."strategy" AS ENUM('csp', 'cc', 'put_credit_spread', 'put_debit_spread', 'call_credit_spread', 'call_debit_spread', 'long_call', 'long_put', 'stock', 'day_trade');--> statement-breakpoint
CREATE TYPE "public"."trade_action" AS ENUM('open', 'close', 'expire', 'assign', 'exercise');--> statement-breakpoint
CREATE TYPE "public"."trade_source" AS ENUM('manual', 'ibkr_upload', 'ibkr_flex');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"broker" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_label_unique" UNIQUE("label"),
	CONSTRAINT "accounts_broker" CHECK ("accounts"."broker" in ('ibkr','manual'))
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"option_trade_id" uuid NOT NULL,
	"stock_trade_id" uuid NOT NULL,
	"shares" integer NOT NULL,
	"premium_per_share" numeric(12,4) NOT NULL,
	CONSTRAINT "assignments_optionTradeId_unique" UNIQUE("option_trade_id"),
	CONSTRAINT "assignments_stockTradeId_unique" UNIQUE("stock_trade_id"),
	CONSTRAINT "assignments_shares" CHECK ("assignments"."shares" > 0)
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"title" text NOT NULL,
	"opened_on" date NOT NULL,
	"closed_on" date,
	"notes" text,
	CONSTRAINT "campaigns_dates" CHECK ("campaigns"."closed_on" is null or "campaigns"."closed_on" >= "campaigns"."opened_on")
);
--> statement-breakpoint
CREATE TABLE "legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"kind" "leg_kind" NOT NULL,
	"side" "side" NOT NULL,
	"underlying" text NOT NULL,
	"strike" numeric(12,4),
	"expiry" date,
	"multiplier" integer DEFAULT 100 NOT NULL,
	"adjusted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "legs_strike" CHECK ("legs"."strike" > 0),
	CONSTRAINT "legs_multiplier" CHECK ("legs"."multiplier" > 0),
	CONSTRAINT "legs_shape" CHECK (("legs"."kind" = 'stock' and "legs"."strike" is null and "legs"."expiry" is null) or ("legs"."kind" in ('put','call') and "legs"."strike" is not null and "legs"."expiry" is not null)),
	CONSTRAINT "legs_stock_multiplier" CHECK ("legs"."kind" <> 'stock' or "legs"."multiplier" = 1)
);
--> statement-breakpoint
CREATE TABLE "marks" (
	"leg_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"price" numeric(12,4) NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "marks_leg_id_as_of_source_pk" PRIMARY KEY("leg_id","as_of","source"),
	CONSTRAINT "marks_price" CHECK ("marks"."price" > 0),
	CONSTRAINT "marks_source" CHECK ("marks"."source" in ('manual','feed'))
);
--> statement-breakpoint
CREATE TABLE "platform_heartbeat" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "platform_heartbeat_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"roll_chain_id" uuid,
	"underlying" text NOT NULL,
	"strategy" "strategy" NOT NULL,
	"role" "position_role" NOT NULL,
	"opened_on" date NOT NULL,
	"closed_on" date,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"notes" text,
	CONSTRAINT "positions_underlying" CHECK ("positions"."underlying" ~ '^[A-Z][A-Z0-9.]{0,9}$'),
	CONSTRAINT "positions_dates" CHECK ("positions"."closed_on" is null or "positions"."closed_on" >= "positions"."opened_on")
);
--> statement-breakpoint
CREATE TABLE "roll_chains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rolls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roll_chain_id" uuid NOT NULL,
	"rolled_on" date NOT NULL,
	"detected_by" text DEFAULT 'manual' NOT NULL,
	CONSTRAINT "rolls_detected_by" CHECK ("rolls"."detected_by" in ('manual','order_id','timestamp','same_day'))
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leg_id" uuid NOT NULL,
	"action" "trade_action" NOT NULL,
	"trade_date" date NOT NULL,
	"executed_at" timestamp with time zone,
	"quantity" integer NOT NULL,
	"price" numeric(12,4) NOT NULL,
	"cash" numeric(14,4) NOT NULL,
	"fees" numeric(14,4) DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"roll_id" uuid,
	"source" "trade_source" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trades_quantity" CHECK ("trades"."quantity" > 0),
	CONSTRAINT "trades_price" CHECK ("trades"."price" >= 0),
	CONSTRAINT "trades_fees" CHECK ("trades"."fees" <= 0),
	CONSTRAINT "trades_currency" CHECK ("trades"."currency" = 'USD')
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_option_trade_id_trades_id_fk" FOREIGN KEY ("option_trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_stock_trade_id_trades_id_fk" FOREIGN KEY ("stock_trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_roll_chain_id_roll_chains_id_fk" FOREIGN KEY ("roll_chain_id") REFERENCES "public"."roll_chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roll_chains" ADD CONSTRAINT "roll_chains_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rolls" ADD CONSTRAINT "rolls_roll_chain_id_roll_chains_id_fk" FOREIGN KEY ("roll_chain_id") REFERENCES "public"."roll_chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_roll_id_rolls_id_fk" FOREIGN KEY ("roll_id") REFERENCES "public"."rolls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "positions_open" ON "positions" USING btree ("campaign_id") WHERE "positions"."closed_on" is null;--> statement-breakpoint
CREATE INDEX "positions_tags" ON "positions" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "trades_leg" ON "trades" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX "trades_date" ON "trades" USING btree ("trade_date");