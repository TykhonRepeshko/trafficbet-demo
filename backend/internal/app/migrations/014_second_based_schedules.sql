-- Preserve saved durations during the unit conversion; operators can then
-- shorten future rounds without rewriting any published market terms.
ALTER TABLE round_schedules RENAME COLUMN entry_minutes TO entry_seconds;
ALTER TABLE round_schedules RENAME COLUMN counting_minutes TO counting_seconds;
ALTER TABLE round_schedules DROP CONSTRAINT round_schedules_entry_minutes_check;
ALTER TABLE round_schedules DROP CONSTRAINT round_schedules_counting_minutes_check;
UPDATE round_schedules SET entry_seconds=entry_seconds*60, counting_seconds=counting_seconds*60;
ALTER TABLE round_schedules ADD CHECK (entry_seconds BETWEEN 30 AND 3600);
ALTER TABLE round_schedules ADD CHECK (counting_seconds BETWEEN 30 AND 3600);
