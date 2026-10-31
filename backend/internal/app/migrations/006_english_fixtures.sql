-- Translate only known, system-created fixture labels. User-authored names,
-- published cutoffs, outcomes and all credit history remain untouched.
WITH translated AS (
 UPDATE users SET display_name=CASE email WHEN 'admin@example.com' THEN 'Administrator' ELSE 'Demo player' END
 WHERE (email='admin@example.com' AND display_name='Администратор')
    OR (email='player@example.com' AND display_name='Тестовый пользователь')
 RETURNING id
)
INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,details)
SELECT NULL,'fixture.localized','user',id,'{"language":"en"}'::jsonb FROM translated;

WITH translated AS (
 UPDATE bet_markets m SET title=CASE
  WHEN m.title='Машины в следующем видеофрагменте · ручное подтверждение' THEN 'Vehicles in the next video clip · manual confirmation'
  ELSE 'Shibuya: vehicles in 10 minutes · manual count' END
 FROM streams s
 WHERE s.id=m.stream_id AND (
  (s.source_owner='Transport for London' AND s.stream_url LIKE 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/%' AND m.title='Машины в следующем видеофрагменте · ручное подтверждение') OR
  (s.stream_url='https://www.youtube.com/watch?v=8H3nRCFVR6Y' AND m.title='Сибуя: машины за 10 минут · ручной подсчёт')
 ) RETURNING m.id
)
INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,details)
SELECT NULL,'fixture.localized','market',id,'{"language":"en"}'::jsonb FROM translated;
