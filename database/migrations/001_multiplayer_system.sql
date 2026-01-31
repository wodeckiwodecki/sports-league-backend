-- Multiplayer Sports League Database Schema
-- Supports NBA and MLB with full GM simulation features

-- Add sport column to leagues
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS sport VARCHAR(10) DEFAULT 'NBA' CHECK (sport IN ('NBA', 'MLB'));
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS league_settings JSONB DEFAULT '{}'::jsonb;
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS commissioner_user_id INTEGER REFERENCES users(id);
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'setup' CHECK (status IN ('setup', 'draft', 'regular_season', 'playoffs', 'completed'));
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS max_teams INTEGER DEFAULT 30;
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS current_season INTEGER DEFAULT 1;

-- League Settings stored in JSONB:
-- {
--   "playerPool": "all_active" | "historical_season" | "draft_class" | "custom",
--   "historicalYear": 2023,  // if playerPool is historical_season
--   "draftClass": 2024,  // if playerPool is draft_class
--   "salaryCap": 120000000,
--   "luxuryTax": 150000000,
--   "draftType": "snake" | "linear",
--   "draftRounds": 7,
--   "regularSeasonGames": 82,  // NBA: 82, MLB: 162
--   "playoffTeams": 16,
--   "playoffFormat": "best_of_7"
-- }

-- League Invitations
CREATE TABLE IF NOT EXISTS league_invitations (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_email VARCHAR(255),
    invitee_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    invited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMP,
    UNIQUE(league_id, invitee_email)
);

CREATE INDEX IF NOT EXISTS idx_invitations_league ON league_invitations(league_id);
CREATE INDEX IF NOT EXISTS idx_invitations_invitee_email ON league_invitations(invitee_email);
CREATE INDEX IF NOT EXISTS idx_invitations_invitee_user ON league_invitations(invitee_user_id);

-- Team Ownership (one user per team per league)
ALTER TABLE teams ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_ai_controlled BOOLEAN DEFAULT FALSE;

-- Add unique constraint: one user can only own one team per league
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_user_league ON teams(league_id, user_id) WHERE user_id IS NOT NULL;

-- Player enhancements for MLB
ALTER TABLE players ADD COLUMN IF NOT EXISTS sport VARCHAR(10) DEFAULT 'NBA' CHECK (sport IN ('NBA', 'MLB'));
ALTER TABLE players ADD COLUMN IF NOT EXISTS mlb_stats JSONB DEFAULT '{}'::jsonb;
ALTER TABLE players ADD COLUMN IF NOT EXISTS historical_year INTEGER;
ALTER TABLE players ADD COLUMN IF NOT EXISTS draft_class INTEGER;

-- MLB Stats stored in JSONB:
-- {
--   "batting": {"avg": 0.285, "hr": 25, "rbi": 90, "sb": 15},
--   "pitching": {"era": 3.45, "wins": 12, "strikeouts": 180, "saves": 0}
-- }

-- Draft picks tracking
CREATE TABLE IF NOT EXISTS draft_picks (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    round INTEGER NOT NULL,
    pick_number INTEGER NOT NULL,
    original_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    current_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    player_id INTEGER REFERENCES players(id),
    picked_at TIMESTAMP,
    UNIQUE(league_id, season, round, pick_number)
);

CREATE INDEX IF NOT EXISTS idx_draft_picks_league ON draft_picks(league_id);
CREATE INDEX IF NOT EXISTS idx_draft_picks_team ON draft_picks(current_team_id);

-- Live draft state
CREATE TABLE IF NOT EXISTS draft_state (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL UNIQUE REFERENCES leagues(id) ON DELETE CASCADE,
    current_round INTEGER DEFAULT 1,
    current_pick INTEGER DEFAULT 1,
    current_team_id INTEGER REFERENCES teams(id),
    pick_timer_seconds INTEGER DEFAULT 120,
    pick_started_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'paused', 'completed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Commissioner actions log
CREATE TABLE IF NOT EXISTS commissioner_actions (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    commissioner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_type VARCHAR(50) NOT NULL,
    action_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_commissioner_actions_league ON commissioner_actions(league_id);

-- Trade enhancements for multi-user
ALTER TABLE trades ADD COLUMN IF NOT EXISTS proposed_by_user_id INTEGER REFERENCES users(id);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS requires_commissioner_approval BOOLEAN DEFAULT FALSE;

-- Add notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
    notification_type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT,
    data JSONB DEFAULT '{}'::jsonb,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read);

-- League activity feed
CREATE TABLE IF NOT EXISTS league_activity (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    activity_type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_league_activity_league ON league_activity(league_id);
CREATE INDEX IF NOT EXISTS idx_league_activity_created ON league_activity(league_id, created_at DESC);
