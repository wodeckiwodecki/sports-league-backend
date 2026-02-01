const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const nbaApiService = require('../services/nbaApiService');
const mlbApiService = require('../services/mlbApiService');

/**
 * POST /api/leagues-v2/create-multiplayer
 * Create a new multiplayer league with full settings
 */
router.post('/create-multiplayer', async (req, res) => {
  const {
    name,
    sport = 'NBA',
    maxTeams = 30,
    settings = {},
    userId
  } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Default settings based on sport
    const defaultSettings = sport === 'NBA' ? {
      playerPool: 'all_active',
      historicalYear: null,
      draftClass: null,
      salaryCap: 120000000,
      luxuryTax: 150000000,
      draftType: 'snake',
      draftRounds: 7,
      regularSeasonGames: 82,
      playoffTeams: 16,
      playoffFormat: 'best_of_7'
    } : {
      playerPool: 'all_active',
      historicalYear: null,
      draftClass: null,
      salaryCap: 200000000,
      luxuryTax: 230000000,
      draftType: 'snake',
      draftRounds: 40,
      regularSeasonGames: 162,
      playoffTeams: 12,
      playoffFormat: 'best_of_7'
    };

    const leagueSettings = { ...defaultSettings, ...settings };

    // Check if columns exist, if not, add them
    try {
      await client.query(`
        ALTER TABLE leagues 
        ADD COLUMN IF NOT EXISTS sport VARCHAR(10) DEFAULT 'NBA',
        ADD COLUMN IF NOT EXISTS league_settings JSONB DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS commissioner_user_id INTEGER,
        ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'setup',
        ADD COLUMN IF NOT EXISTS max_teams INTEGER DEFAULT 30,
        ADD COLUMN IF NOT EXISTS current_season INTEGER DEFAULT 1
      `);
    } catch (err) {
      console.log('Columns may already exist:', err.message);
    }

    // Get username
    const userResult = await client.query('SELECT username FROM users WHERE id = $1', [userId]);
    const username = userResult.rows[0]?.username || 'User';

    // Create league
    const leagueResult = await client.query(
      `INSERT INTO leagues 
       (name, sport, max_teams, league_settings, commissioner_user_id, status, owner_id, salary_cap, time_ratio, draft_type, player_pool)
       VALUES ($1, $2, $3, $4, $5, 'setup', $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        name, 
        sport, 
        maxTeams, 
        JSON.stringify(leagueSettings), 
        userId,
        leagueSettings.salaryCap,
        JSON.stringify({ real_hours: 24, league_days: 7 }),
        leagueSettings.draftType,
        JSON.stringify({ type: leagueSettings.playerPool })
      ]
    );
    
    const league = leagueResult.rows[0];

    // Ensure teams table has user_id column
    try {
      await client.query('ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_ai_controlled BOOLEAN DEFAULT FALSE');
    } catch (err) {
      console.log('Column may already exist:', err.message);
    }

    // Create first team for commissioner
    const teamResult = await client.query(
      `INSERT INTO teams (name, league_id, user_id, abbreviation)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [`${username}'s Team`, league.id, userId, 'T1']
    );

    // Create activity table if it doesn't exist
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS league_activity (
          id SERIAL PRIMARY KEY,
          league_id INTEGER NOT NULL,
          activity_type VARCHAR(50) NOT NULL,
          title VARCHAR(255) NOT NULL,
          description TEXT,
          data JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch (err) {
      console.log('Table may already exist:', err.message);
    }

    // Create activity
    await client.query(
      `INSERT INTO league_activity (league_id, activity_type, title, description)
       VALUES ($1, 'league_created', 'League Created', $2)`,
      [league.id, `${username} created the league`]
    );

    await client.query('COMMIT');

    res.status(201).json({ 
      league,
      team: teamResult.rows[0],
      settings: leagueSettings
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating multiplayer league:', error);
    res.status(500).json({ error: 'Failed to create league', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/leagues-v2/:id/import-players
 * Import players based on league settings
 */

/**
 * GET /api/leagues-v2/:id
 * Get league details by ID
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT 
        l.*,
        u.username as commissioner_username
      FROM leagues l
      LEFT JOIN users u ON l.commissioner_user_id = u.id
      WHERE l.id = $1
    `, [id]);
    
    if (!result.rows.length) {
      return res.status(404).json({ error: 'League not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching league:', error);
    res.status(500).json({ error: 'Failed to fetch league' });
  }
});

/**
 * GET /api/leagues-v2/:id/teams
 * Get all teams in a league
 */
router.get('/:id/teams', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT 
        t.*,
        u.username as owner_username,
        (SELECT COUNT(*) FROM team_rosters WHERE team_id = t.id) as player_count
      FROM teams t
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.league_id = $1
      ORDER BY t.created_at
    `, [id]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

router.post('/:id/import-players', async (req, res) => {
  const { id } = req.params;
  
  try {
    const leagueResult = await pool.query(
      'SELECT sport, league_settings FROM leagues WHERE id = $1',
      [id]
    );
    
    if (!leagueResult.rows.length) {
      return res.status(404).json({ error: 'League not found' });
    }
    
    const league = leagueResult.rows[0];
    const settings = league.league_settings || {};

    console.log(`Setting up player pool for ${league.sport} league`);

    // Check how many players exist in database for this sport
    const playerCount = await pool.query(
      'SELECT COUNT(*) FROM players WHERE sport = $1',
      [league.sport]
    );

    const count = parseInt(playerCount.rows[0].count);
    console.log(`Found ${count} ${league.sport} players already in database`);

    if (count === 0) {
      return res.status(400).json({ 
        error: `No ${league.sport} players found in database. Run the populate script first.` 
      });
    }

    // Players are already in database, just return success
    res.json({ 
      success: true, 
      playersImported: count,
      playerPool: settings.playerPool,
      sport: league.sport,
      message: 'Players already available in database'
    });

  } catch (error) {
    console.error('Error setting up player pool:', error);
    res.status(500).json({ error: 'Failed to setup player pool', details: error.message });
  }
});

module.exports = router;
