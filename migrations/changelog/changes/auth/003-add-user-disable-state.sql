-- Administrative disablement is durable and invalidates every existing session.
ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION auth.revoke_sessions_when_user_disabled()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.disabled = TRUE AND OLD.disabled = FALSE THEN
        DELETE FROM auth.sessions WHERE "userId" = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS revoke_sessions_when_user_disabled ON auth.users;

CREATE TRIGGER revoke_sessions_when_user_disabled
AFTER UPDATE OF disabled ON auth.users
FOR EACH ROW
EXECUTE FUNCTION auth.revoke_sessions_when_user_disabled();

CREATE OR REPLACE FUNCTION auth.reject_session_for_disabled_user()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    user_disabled BOOLEAN;
BEGIN
    -- Serialize session creation with disablement. Whichever transaction wins,
    -- no session can survive the disabled transition and reactivate later.
    SELECT disabled
      INTO user_disabled
      FROM auth.users
     WHERE id = NEW."userId"
     FOR UPDATE;

    IF user_disabled = TRUE THEN
        RAISE EXCEPTION 'cannot create session for disabled user'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reject_session_for_disabled_user ON auth.sessions;

CREATE TRIGGER reject_session_for_disabled_user
BEFORE INSERT ON auth.sessions
FOR EACH ROW
EXECUTE FUNCTION auth.reject_session_for_disabled_user();
