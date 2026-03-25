-- Migrate pending rooms to active, then replace the enum

ALTER TABLE rooms ALTER COLUMN status DROP DEFAULT;

UPDATE rooms SET status = 'active' WHERE status = 'pending';

ALTER TYPE room_status RENAME TO room_status_old;

CREATE TYPE room_status AS ENUM ('active', 'inactive', 'ended');

ALTER TABLE rooms
  ALTER COLUMN status TYPE room_status
  USING status::text::room_status;

DROP TYPE room_status_old;

ALTER TABLE rooms ALTER COLUMN status SET DEFAULT 'active';
