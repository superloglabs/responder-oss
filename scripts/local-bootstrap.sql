DO $$
DECLARE
  profile_id uuid;
BEGIN
  SELECT runtime_profiles.id
  INTO profile_id
  FROM instance_configuration
  INNER JOIN runtime_profiles
    ON runtime_profiles.id = instance_configuration.active_runtime_profile_id
  WHERE instance_configuration.id = 'default';

  IF profile_id IS NULL THEN
    SELECT id
    INTO profile_id
    FROM runtime_profiles
    ORDER BY version DESC
    LIMIT 1;

    IF profile_id IS NULL THEN
      INSERT INTO runtime_profiles (
        system_prompt,
        model,
        model_options,
        created_by
      )
      VALUES (
        'You are Responder, an incident investigation agent. Investigate carefully, ground conclusions in evidence, and report concrete remediation steps.',
        'anthropic/claude-sonnet-4.5',
        '{}'::jsonb,
        'local-bootstrap'
      )
      RETURNING id INTO profile_id;
    END IF;

    INSERT INTO instance_configuration (
      id,
      active_runtime_profile_id,
      updated_by
    )
    VALUES ('default', profile_id, 'local-bootstrap')
    ON CONFLICT (id) DO UPDATE
    SET active_runtime_profile_id = EXCLUDED.active_runtime_profile_id,
        updated_by = EXCLUDED.updated_by,
        updated_at = now();
  END IF;
END $$;
