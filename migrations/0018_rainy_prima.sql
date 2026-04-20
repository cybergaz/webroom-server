ALTER TABLE "admin_user_adoptions" ADD COLUMN "locked_device_id" varchar(255);--> statement-breakpoint
ALTER TABLE "admin_user_adoptions" ADD COLUMN "locked_device_name" varchar(255);--> statement-breakpoint
ALTER TABLE "admin_user_adoptions" ADD COLUMN "allow_device_change" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "room_members" ADD COLUMN "added_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_added_by_admin_id_users_id_fk" FOREIGN KEY ("added_by_admin_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_room_members_added_by_admin" ON "room_members" USING btree ("added_by_admin_id");--> statement-breakpoint
UPDATE "admin_user_adoptions" a
  SET "locked_device_id" = u."locked_device_id",
      "locked_device_name" = u."locked_device_name",
      "allow_device_change" = u."allow_device_change"
  FROM "users" u
  WHERE u."id" = a."user_id";--> statement-breakpoint
UPDATE "room_members" rm
  SET "added_by_admin_id" = r."created_by"
  FROM "rooms" r, "users" creator
  WHERE r."id" = rm."room_id"
    AND creator."id" = r."created_by"
    AND creator."role" = 'admin';--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "locked_device_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "locked_device_name";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "allow_device_change";