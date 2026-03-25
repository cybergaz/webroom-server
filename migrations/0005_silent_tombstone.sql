ALTER TABLE "rooms" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "status" SET DEFAULT 'active'::text;--> statement-breakpoint
DROP TYPE "public"."room_status";--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('active', 'inactive', 'ended');--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "status" SET DEFAULT 'active'::"public"."room_status";--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "status" SET DATA TYPE "public"."room_status" USING "status"::"public"."room_status";