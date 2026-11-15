-- 변경 알림 (PC ↔ 휴대폰 실시간 동기화). 내용 없이 org_id + 테이블 + id만 전달.
CREATE OR REPLACE FUNCTION ss_notify_change() RETURNS trigger AS $$
DECLARE
  rec jsonb;
  oid text;
BEGIN
  rec := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  oid := rec->>'org_id';
  IF oid IS NULL AND TG_TABLE_NAME = 'ai_messages' THEN
    SELECT org_id::text INTO oid FROM ai_threads WHERE id = (rec->>'thread_id')::uuid;
  END IF;
  IF oid IS NOT NULL THEN
    PERFORM pg_notify('ss_changes', json_build_object('org', oid, 't', TG_TABLE_NAME, 'id', rec->>'id', 'op', TG_OP)::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','messages','internal_notes','opportunities','tasks','projects','schedule_blocks','payments',
                           'contracts','quotes','notifications','ai_messages','reports','events','outbound_messages','ideas','attachments','contacts','approvals']
  LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ss_notify_change()', t || '_ss_notify', t);
  END LOOP;
END $$;
