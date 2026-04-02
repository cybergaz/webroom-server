CREATE TABLE "session_transcriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_transcriptions" ADD CONSTRAINT "session_transcriptions_session_id_room_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."room_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_transcriptions" ADD CONSTRAINT "session_transcriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_session_transcriptions_session" ON "session_transcriptions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_session_transcriptions_user" ON "session_transcriptions" USING btree ("user_id");