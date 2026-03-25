ALTER TABLE "organisations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "organisations" CASCADE;--> statement-breakpoint
ALTER TABLE "room_sessions" DROP CONSTRAINT "room_sessions_organisation_id_organisations_id_fk";
--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_organisation_id_organisations_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_organisation_id_organisations_id_fk";
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'user'::text;--> statement-breakpoint
DROP TYPE "public"."user_role";--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'host', 'admin', 'super_admin');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'user'::"public"."user_role";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE "public"."user_role" USING "role"::"public"."user_role";--> statement-breakpoint
DROP INDEX "idx_room_sessions_org";--> statement-breakpoint
DROP INDEX "idx_rooms_organisation";--> statement-breakpoint
ALTER TABLE "room_sessions" DROP COLUMN "organisation_id";--> statement-breakpoint
ALTER TABLE "rooms" DROP COLUMN "organisation_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "organisation_id";