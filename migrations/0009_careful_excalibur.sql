CREATE TABLE "ptt_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"s3_key" varchar(512) NOT NULL,
	"duration_ms" integer NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"mime_type" varchar(64) DEFAULT 'audio/mp4' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ptt_recordings" ADD CONSTRAINT "ptt_recordings_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ptt_recordings" ADD CONSTRAINT "ptt_recordings_session_id_room_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."room_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ptt_recordings" ADD CONSTRAINT "ptt_recordings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ptt_recordings_room" ON "ptt_recordings" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "idx_ptt_recordings_session" ON "ptt_recordings" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_ptt_recordings_user" ON "ptt_recordings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ptt_recordings_created_at" ON "ptt_recordings" USING btree ("created_at");