ALTER TABLE "users" ADD COLUMN "locked_device_id" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locked_device_name" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "allow_device_change" boolean DEFAULT false NOT NULL;