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
    let players = [];

    console.log(`Importing players for ${league.sport} league with settings:`, settings);

    // Ensure players table has needed columns
    const client = await pool.connect();
    try {
      await client.query(`
        ALTER TABLE players 
        ADD COLUMN IF NOT EXISTS sport VARCHAR(10) DEFAULT 'NBA',
        ADD COLUMN IF NOT EXISTS mlb_stats JSONB DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS historical_year INTEGER,
        ADD COLUMN IF NOT EXISTS draft_class INTEGER,
        ADD COLUMN IF NOT EXISTS birth_date DATE,
        ADD COLUMN IF NOT EXISTS height VARCHAR(10),
        ADD COLUMN IF NOT EXISTS weight INTEGER
      `);
    } catch (err) {
      console.log('Columns may already exist:', err.message);
    } finally {
      client.release();
    }

    // Import based on player pool setting
    if (league.sport === 'NBA') {
      if (settings.playerPool === 'all_active') {
        console.log('Importing all active NBA players...');
        players = await nbaApiService.getAllActivePlayers();
      }
    } else if (league.sport === 'MLB') {
      const currentYear = new Date().getFullYear();
      
      if (settings.playerPool === 'all_active') {
        console.log('Importing all active MLB players...');
        players = await mlbApiService.getAllPlayersForSeason(currentYear);
      } else if (settings.playerPool === 'historical_season' && settings.historicalYear) {
        console.log(`Importing MLB players from ${settings.historicalYear}...`);
        players = await mlbApiService.getAllPlayersForSeason(settings.historicalYear);
      }
    }

    if (!players || players.length === 0) {
      return res.status(400).json({ error: 'No players found for the selected settings' });
    }

    console.log(`Found ${players.length} players, inserting into database...`);

    // Insert players
    const client2 = await pool.connect();
    let inserted = 0;
    
    try {
      await client2.query('BEGIN');

      for (const player of players) {
        try {
          const existing = await client2.query(
            'SELECT id FROM players WHERE external_id = $1',
            [player.external_id]
          );

          if (existing.rows.length === 0) {
            await client2.query(
              `INSERT INTO players (
                external_id, name, sport, position, age, overall_rating,
                team, historical_year, draft_class, mlb_stats, height, weight, birth_date
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
              [
                player.external_id,
                player.name,
                league.sport,
                player.position || 'G',
                player.age || 25,
                player.overall_rating || 75,
                player.team || 'Free Agent',
                player.historical_year || null,
                player.draft_class || null,
                player.mlb_stats ? JSON.stringify(player.mlb_stats) : null,
                player.height || null,
                player.weight || null,
                player.birth_date || null
              ]
            );
            inserted++;
          }
        } catch (err) {
          console.error(`Error inserting player ${player.name}:`, err.message);
        }
      }

      await client2.query('COMMIT');

      console.log(`Successfully imported ${inserted} players`);

      res.json({ 
        success: true, 
        playersImported: inserted,
        playerPool: settings.playerPool,
        sport: league.sport
      });
    } catch (error) {
      await client2.query('ROLLBACK');
      throw error;
    } finally {
      client2.release();
    }
  } catch (error) {
    console.error('Error importing players:', error);
    res.status(500).json({ error: 'Failed to import players', details: error.message });
  }
});

module.exports = router;
