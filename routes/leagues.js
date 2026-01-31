const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

/**
 * POST /api/leagues
 * Create a new league
 */
router.post('/', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const {
      name,
      ownerId,
      sport,
      salaryCap,
      timeRatio,
      draftType,
      playerPool
    } = req.body;

    await client.query('BEGIN');

    // Create league
    const leagueResult = await client.query(
      `INSERT INTO leagues 
       (name, owner_id, sport, salary_cap, time_ratio, draft_type, player_pool)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        name,
        ownerId,
        sport,
        salaryCap || 150000000,
        JSON.stringify(timeRatio || { real_hours: 24, league_days: 7 }),
        draftType || 'snake',
        JSON.stringify(playerPool || [])
      ]
    );

    const league = leagueResult.rows[0];

    // Create owner's team
    await client.query(
      `INSERT INTO teams (league_id, user_id, name, abbreviation)
       VALUES ($1, $2, $3, $4)`,
      [league.id, ownerId, `Team ${ownerId}`, 'T1']
    );

    await client.query('COMMIT');

    res.status(201).json(league);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating league:', error);
    res.status(500).json({ error: 'Failed to create league' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/leagues/:leagueId
 * Get league details
 */
router.get('/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;

    const result = await pool.query(
      `SELECT l.*, u.username as owner_username
       FROM leagues l
       JOIN users u ON l.owner_id = u.id
       WHERE l.id = $1`,
      [leagueId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'League not found' });
    }

    const league = result.rows[0];

    // Get team count
    const teamCountResult = await pool.query(
      'SELECT COUNT(*) FROM teams WHERE league_id = $1',
      [leagueId]
    );

    league.team_count = parseInt(teamCountResult.rows[0].count);

    res.json(league);
  } catch (error) {
    console.error('Error fetching league:', error);
    res.status(500).json({ error: 'Failed to fetch league' });
  }
});

/**
 * GET /api/leagues
 * Get all leagues (optionally filter by user)
 */
router.get('/', async (req, res) => {
  try {
    const { userId } = req.query;

    let query = `
      SELECT l.*, u.username as owner_username,
             COUNT(DISTINCT t.id) as team_count
      FROM leagues l
      JOIN users u ON l.owner_id = u.id
      LEFT JOIN teams t ON l.id = t.league_id
    `;

    const params = [];

    if (userId) {
      query += ' WHERE l.owner_id = $1 OR t.user_id = $1';
      params.push(userId);
    }

    query += ' GROUP BY l.id, u.username ORDER BY l.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching leagues:', error);
    res.status(500).json({ error: 'Failed to fetch leagues' });
  }
});

/**
 * PUT /api/leagues/:leagueId
 * Update league settings
 */
router.put('/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { name, salaryCap, timeRatio, settings } = req.body;

    const updates = [];
    const params = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount}`);
      params.push(name);
      paramCount++;
    }

    if (salaryCap) {
      updates.push(`salary_cap = $${paramCount}`);
      params.push(salaryCap);
      paramCount++;
    }

    if (timeRatio) {
      updates.push(`time_ratio = $${paramCount}`);
      params.push(JSON.stringify(timeRatio));
      paramCount++;
    }

    if (settings) {
      updates.push(`settings = $${paramCount}`);
      params.push(JSON.stringify(settings));
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    params.push(leagueId);

    const result = await pool.query(
      `UPDATE leagues SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'League not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating league:', error);
    res.status(500).json({ error: 'Failed to update league' });
  }
});

/**
 * GET /api/leagues/:leagueId/storylines
 * Get recent storylines for a league
 */
router.get('/:leagueId/storylines', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { limit = 10 } = req.query;

    const result = await pool.query(
      `SELECT * FROM storylines 
       WHERE league_id = $1 
       ORDER BY season DESC, day DESC 
       LIMIT $2`,
      [leagueId, limit]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching storylines:', error);
    res.status(500).json({ error: 'Failed to fetch storylines' });
  }
});

/**
 * POST /api/leagues/:leagueId/advance
 * Manually advance the league (for testing or immediate progression)
 */
router.post('/:leagueId/advance', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { days = 1 } = req.body;

    const leagueResult = await pool.query(
      'SELECT * FROM leagues WHERE id = $1',
      [leagueId]
    );

    if (leagueResult.rows.length === 0) {
      return res.status(404).json({ error: 'League not found' });
    }

    const league = leagueResult.rows[0];
    
    // Import the time progression service
    const { advanceLeagueDay } = require('../services/timeProgressionService');
    const io = req.app.get('io');
    
    const client = await pool.connect();
    try {
      for (let i = 0; i < days; i++) {
        await advanceLeagueDay(client, league, io);
      }
      
      res.json({ 
        message: `Advanced league ${days} day(s)`,
        currentDay: league.current_day + days
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error advancing league:', error);
    res.status(500).json({ error: 'Failed to advance league' });
  }
});

module.exports = router;
