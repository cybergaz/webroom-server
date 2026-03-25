ALTER TABLE "users" DROP CONSTRAINT "users_phone_unique";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "request_id" varchar(8);--> statement-breakpoint
CREATE INDEX "idx_users_request_id" ON "users" USING btree ("request_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_request_id_unique" UNIQUE("request_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");