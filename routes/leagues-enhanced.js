const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const authenticate = require('../middleware/authenticate');
const nbaApiService = require('../services/nbaApiService');
const mlbApiService = require('../services/mlbApiService');

/**
 * POST /api/leagues-v2/create-multiplayer
 * Create a new multiplayer league with full settings
 */
router.post('/create-multiplayer', authenticate, async (req, res) => {
  const {
    name,
    sport = 'MLB',
    maxTeams = 12,
    settings = {},
    teamName
  } = req.body;
  
  const userId = req.user.id; // Get from auth middleware
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Default settings
    const defaultSettings = {
      playerPool: 'all_active',
      salaryCap: sport === 'MLB' ? 200000000 : 120000000,
      luxuryTax: sport === 'MLB' ? 230000000 : 150000000,
      draftType: 'snake',
      draftRounds: sport === 'MLB' ? 40 : 7,
      regularSeasonGames: sport === 'MLB' ? 162 : 82,
      playoffTeams: sport === 'MLB' ? 12 : 16,
      playoffFormat: 'best_of_7'
    };

    const leagueSettings = { ...defaultSettings, ...settings };

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

    // Create first team for commissioner
    const teamResult = await client.query(
      `INSERT INTO teams (name, league_id, user_id, abbreviation)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [teamName || `Team 1`, league.id, userId, 'T1']
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
 * GET /api/leagues-v2/:id/details
 */
router.get('/:id/details', authenticate, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  
  try {
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

    const teamsResult = await pool.query(
      `SELECT t.*, u.username, u.email
       FROM teams t
       LEFT JOIN users u ON t.user_id = u.id
       WHERE t.league_id = $1
       ORDER BY t.id`,
      [id]
    );

    const userTeam = teamsResult.rows.find(t => t.user_id === userId);
    const isCommissioner = (league.commissioner_user_id === userId) || (league.owner_id === userId);

    res.json({
      league,
      teams: teamsResult.rows,
      userTeam,
      isCommissioner,
      settings: league.league_settings || {}
    });
  } catch (error) {
    console.error('Error fetching league details:', error);
    res.status(500).json({ error: 'Failed to fetch league details' });
  }
});

/**
 * POST /api/leagues-v2/:id/import-players
 */
router.post('/:id/import-players', authenticate, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  
  try {
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

    console.log(`Importing players for ${league.sport} league...`);

    if (league.sport === 'MLB') {
      const currentYear = new Date().getFullYear();
      
      if (settings.playerPool === 'all_active') {
        players = await mlbApiService.getAllPlayersForSeason(currentYear);
      } else if (settings.playerPool === 'historical_season' && settings.historicalYear) {
        players = await mlbApiService.getAllPlayersForSeason(settings.historicalYear);
      }
    }

    if (!players || players.length === 0) {
      return res.status(400).json({ error: 'No players found' });
    }

    console.log(`Found ${players.length} players, inserting...`);

    const client = await pool.connect();
    let inserted = 0;
    
    try {
      await client.query('BEGIN');

      for (const player of players) {
        try {
          const existing = await client.query(
            'SELECT id FROM players WHERE external_id = $1',
            [player.external_id]
          );

          if (existing.rows.length === 0) {
            await client.query(
              `INSERT INTO players (
                external_id, name, sport, position, age, overall_rating,
                team, historical_year, mlb_stats, height, weight, birth_date
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [
                player.external_id,
                player.name,
                league.sport,
                player.position || 'P',
                player.age || 25,
                player.overall_rating || 75,
                player.team || 'Free Agent',
                player.historical_year || null,
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

      await client.query('COMMIT');

      res.json({ 
        success: true, 
        playersImported: inserted,
        sport: league.sport
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error importing players:', error);
    res.status(500).json({ error: 'Failed to import players', details: error.message });
  }
});

module.exports = router;
