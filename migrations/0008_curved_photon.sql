CREATE TABLE "admin_user_adoptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"adopted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_admin_user_adoptions" UNIQUE("admin_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "admin_user_adoptions" ADD CONSTRAINT "admin_user_adoptions_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_user_adoptions" ADD CONSTRAINT "admin_user_adoptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_admin_user_adoptions_admin" ON "admin_user_adoptions" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "idx_admin_user_adoptions_user" ON "admin_user_adoptions" USING btree ("user_id");