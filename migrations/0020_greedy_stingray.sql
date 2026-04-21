ALTER TABLE "rooms" ADD COLUMN "banners" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "marquee_text" text;