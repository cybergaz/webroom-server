CREATE TYPE "public"."plan_duration" AS ENUM('1_month', '3_months', '6_months', '1_year');--> statement-breakpoint
CREATE TABLE "admin_licenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"plan_duration" "plan_duration" NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"assigned_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_licenses_admin_id_unique" UNIQUE("admin_id")
);
--> statement-breakpoint
ALTER TABLE "admin_licenses" ADD CONSTRAINT "admin_licenses_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_licenses" ADD CONSTRAINT "admin_licenses_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_admin_licenses_expires_at" ON "admin_licenses" USING btree ("expires_at");