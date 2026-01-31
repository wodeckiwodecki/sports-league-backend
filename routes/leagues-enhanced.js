const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const nbaApiService = require('../services/nbaApiService');
const mlbApiService = require('../services/mlbApiService');

/**
 * Middleware to verify user is authenticated
 */
const authenticate = (req, res, next) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

/**
 * POST /api/leagues/create-multiplayer
 * Create a new multiplayer league with full settings
 */
router.post('/create-multiplayer', authenticate, async (req, res) => {
  const {
    name,
    sport = 'NBA',
    maxTeams = 30,
    settings = {}
  } = req.body;
  
  const userId = req.user.id;
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
      [`${req.user.username}'s Team`, league.id, userId, 'T1']
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
      [league.id, `${req.user.username} created the league`]
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
 * GET /api/leagues/:id/details
 * Get comprehensive league details with teams and user info
 */
router.get('/:id/details', authenticate, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  
  try {
    // Get league info
    const leagueResult = await pool.query(
      `SELECT l.*, u.username as commissioner_username
       FROM leagues l
       LEFT JOIN users u ON l.commissioner_user_id = u.id OR l.owner_id = u.id
       WHERE l.id = $1`,
      [id]
    );
    
    if (!leagueResult.rows.length) {
      return res.status(404).json({ error: 'League not found' });
    }

    const league = leagueResult.rows[0];

    // Get all teams with user info
    const teamsResult = await pool.query(
      `SELECT t.*, u.username, u.email
       FROM teams t
       LEFT JOIN users u ON t.user_id = u.id
       WHERE t.league_id = $1
       ORDER BY t.id`,
      [id]
    );

    // Check if user has access
    const userTeam = teamsResult.rows.find(t => t.user_id === userId);
    const isCommissioner = (league.commissioner_user_id === userId) || (league.owner_id === userId);

    if (!userTeam && !isCommissioner) {
      return res.status(403).json({ error: 'You are not a member of this league' });
    }

    // Get recent activity
    const activityResult = await pool.query(
      `SELECT * FROM league_activity
       WHERE league_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [id]
    ).catch(() => ({ rows: [] }));
    
    res.json({
      league,
      teams: teamsResult.rows,
      userTeam,
      isCommissioner,
      activity: activityResult.rows,
      settings: league.league_settings || {}
    });
  } catch (error) {
    console.error('Error fetching league details:', error);
    res.status(500).json({ error: 'Failed to fetch league details' });
  }
});

/**
 * PATCH /api/leagues/:id/settings
 * Update league settings (commissioner only)
 */
router.patch('/:id/settings', authenticate, async (req, res) => {
  const { id } = req.params;
  const { settings } = req.body;
  const userId = req.user.id;
  
  try {
    // Verify commissioner
    const leagueResult = await pool.query(
      'SELECT commissioner_user_id, owner_id, status FROM leagues WHERE id = $1',
      [id]
    );
    
    if (!leagueResult.rows.length) {
      return res.status(404).json({ error: 'League not found' });
    }
    
    const league = leagueResult.rows[0];
    const isCommissioner = (league.commissioner_user_id === userId) || (league.owner_id === userId);
    
    if (!isCommissioner) {
      return res.status(403).json({ error: 'Only the commissioner can update settings' });
    }
    
    if (league.status !== 'setup') {
      return res.status(400).json({ error: 'Cannot modify settings after league has started' });
    }

    const result = await pool.query(
      'UPDATE leagues SET league_settings = $1 WHERE id = $2 RETURNING *',
      [JSON.stringify(settings), id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * POST /api/leagues/:id/import-players
 * Import players based on league settings
 */
router.post('/:id/import-players', authenticate, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  
  try {
    // Verify commissioner
    const leagueResult = await pool.query(
      'SELECT commissioner_user_id, owner_id, sport, league_settings FROM leagues WHERE id = $1',
      [id]
    );
    
    if (!leagueResult.rows.length) {
      return res.status(404).json({ error: 'League not found' });
    }
    
    const league = leagueResult.rows[0];
    const isCommissioner = (league.commissioner_user_id === userId) || (league.owner_id === userId);
    
    if (!isCommissioner) {
      return res.status(403).json({ error: 'Only the commissioner can import players' });
    }

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
      } else if (settings.playerPool === 'historical_season' && settings.historicalYear) {
        console.log(`Importing NBA players from ${settings.historicalYear}...`);
        players = await nbaApiService.getHistoricalRoster(settings.historicalYear);
      } else if (settings.playerPool === 'draft_class' && settings.draftClass) {
        console.log(`Importing NBA draft class ${settings.draftClass}...`);
        players = await nbaApiService.getDraftClass(settings.draftClass);
      }
    } else if (league.sport === 'MLB') {
      const currentYear = new Date().getFullYear();
      
      if (settings.playerPool === 'all_active') {
        console.log('Importing all active MLB players...');
        players = await mlbApiService.getAllPlayersForSeason(currentYear);
      } else if (settings.playerPool === 'historical_season' && settings.historicalYear) {
        console.log(`Importing MLB players from ${settings.historicalYear}...`);
        players = await mlbApiService.getAllPlayersForSeason(settings.historicalYear);
      } else if (settings.playerPool === 'draft_class' && settings.draftClass) {
        console.log(`Importing MLB draft class ${settings.draftClass}...`);
        players = await mlbApiService.getDraftClass(settings.draftClass);
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
          // Check if player exists
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

      // Create activity
      await pool.query(
        `INSERT INTO league_activity (league_id, activity_type, title, description)
         VALUES ($1, 'players_imported', 'Players Imported', $2)`,
        [id, `${inserted} ${league.sport} players imported`]
      ).catch(err => console.log('Could not create activity:', err.message));

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

/**
 * GET /api/leagues/:id/activity
 * Get league activity feed
 */
router.get('/:id/activity', authenticate, async (req, res) => {
  const { id } = req.params;
  const { limit = 50 } = req.query;
  
  try {
    const result = await pool.query(
      `SELECT * FROM league_activity
       WHERE league_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [id, limit]
    ).catch(() => ({ rows: [] }));
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;
