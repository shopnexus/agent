ALTER TABLE actors DROP COLUMN IF EXISTS role;
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS fact_key VARCHAR(64);
ALTER TABLE user_memories DROP COLUMN IF EXISTS role;
UPDATE user_memories SET deleted_at = NOW(), updated_at = NOW()
  WHERE category = 'shop_policy' AND deleted_at IS NULL;
DROP INDEX IF EXISTS idx_user_memories_lookup;
CREATE INDEX idx_user_memories_lookup
  ON user_memories(actor_id, category, superseded_at, deleted_at, expires_at);
