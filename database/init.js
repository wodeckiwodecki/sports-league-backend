const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'sports_league',
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

const initializeDatabase = async () => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        username VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Leagues table
    await client.query(`
      CREATE TABLE IF NOT EXISTS leagues (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        owner_id INTEGER REFERENCES users(id),
        sport VARCHAR(50) NOT NULL,
        salary_cap BIGINT DEFAULT 150000000,
        time_ratio JSONB DEFAULT '{"real_hours": 24, "league_days": 7}'::jsonb,
        current_day INTEGER DEFAULT 1,
        current_season INTEGER DEFAULT 1,
        last_processed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        draft_type VARCHAR(50) DEFAULT 'snake',
        player_pool JSONB DEFAULT '[]'::jsonb,
        settings JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Teams table
    await client.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        name VARCHAR(255) NOT NULL,
        abbreviation VARCHAR(10),
        total_salary BIGINT DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Players table
    await client.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        position VARCHAR(10) NOT NULL,
        age INTEGER,
        overall_rating INTEGER DEFAULT 75,
        potential INTEGER DEFAULT 75,
        draft_year INTEGER,
        draft_class VARCHAR(100),
        attributes JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Team rosters (junction table)
    await client.query(`
      CREATE TABLE IF NOT EXISTS team_rosters (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        player_id INTEGER REFERENCES players(id),
        league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
        contract_years INTEGER DEFAULT 1,
        contract_salary BIGINT DEFAULT 0,
        is_free_agent BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(player_id, league_id)
      )
    `);

    // Player stats table
    await client.query(`
      CREATE TABLE IF NOT EXISTS player_stats (
        id SERIAL PRIMARY KEY,
        player_id INTEGER REFERENCES players(id),
        league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
        season INTEGER NOT NULL,
        games_played INTEGER DEFAULT 0,
        stats JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(player_id, league_id, season)
      )
    `);

    // Trades table
    await client.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
        proposing_team_id INTEGER REFERENCES teams(id),
        receiving_team_id INTEGER REFERENCES teams(id),
        status VARCHAR(50) DEFAULT 'pending',
        offering_players JSONB DEFAULT '[]'::jsonb,
        requesting_players JSONB DEFAULT '[]'::jsonb,
        message TEXT,
        ai_evaluation JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Contract offers table
    await client.query(`
      CREATE TABLE IF NOT EXISTS contract_offers (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id),
        player_id INTEGER REFERENCES players(id),
        league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
        years INTEGER NOT NULL,
        annual_salary BIGINT NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        ai_response TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Games table
    await client.query(`
      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
        home_team_id INTEGER REFERENCES teams(id),
        away_team_id INTEGER REFERENCES teams(id),
        season INTEGER NOT NULL,
        day INTEGER NOT NULL,
        home_score INTEGER,
        away_score INTEGER,
        box_score JSONB,
        narrative TEXT,
        status VARCHAR(50) DEFAULT 'scheduled',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // League storylines table
    await client.query(`
      CREATE TABLE IF NOT EXISTS storylines (
        id SERIAL PRIMARY KEY,
        league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        entities JSONB DEFAULT '{}'::jsonb,
        day INTEGER NOT NULL,
        season INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Drafts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS drafts (
        id SERIAL PRIMARY KEY,
        league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE UNIQUE,
        status VARCHAR(50) DEFAULT 'not_started',
        current_pick INTEGER DEFAULT 1,
        current_round INTEGER DEFAULT 1,
        draft_state JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for better performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_teams_league ON teams(league_id);
      CREATE INDEX IF NOT EXISTS idx_rosters_team ON team_rosters(team_id);
      CREATE INDEX IF NOT EXISTS idx_rosters_league ON team_rosters(league_id);
      CREATE INDEX IF NOT EXISTS idx_stats_player_league ON player_stats(player_id, league_id);
      CREATE INDEX IF NOT EXISTS idx_trades_league ON trades(league_id);
      CREATE INDEX IF NOT EXISTS idx_games_league ON games(league_id);
      CREATE INDEX IF NOT EXISTS idx_storylines_league ON storylines(league_id);
      CREATE INDEX IF NOT EXISTS idx_drafts_league ON drafts(league_id);
    `);

    await client.query('COMMIT');
    console.log('Database initialized successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { pool, initializeDatabase };
