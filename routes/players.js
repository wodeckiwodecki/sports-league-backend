const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

/**
 * GET /api/players
 * Get all players (with optional filters)
 */
router.get('/', async (req, res) => {
  try {
    const { position, minOverall, maxOverall, draftClass, search } = req.query;

    let query = 'SELECT * FROM players WHERE 1=1';
    const params = [];


    // Add sport filter
    if (req.query.sport) {
      query += ` AND sport = $${paramCount}`;
      params.push(req.query.sport);
      paramCount++;
    }


    if (position) {
      query += ` AND position = $${paramCount}`;
      params.push(position);
      paramCount++;
    }

    if (minOverall) {
      query += ` AND overall_rating >= $${paramCount}`;
      params.push(parseInt(minOverall));
      paramCount++;
    }

    if (maxOverall) {
      query += ` AND overall_rating <= $${paramCount}`;
      params.push(parseInt(maxOverall));
      paramCount++;
    }

    if (draftClass) {
      query += ` AND draft_class = $${paramCount}`;
      params.push(draftClass);
      paramCount++;
    }

    if (search) {
      query += ` AND name ILIKE $${paramCount}`;
      params.push(`%${search}%`);
      paramCount++;
    }

    // Use limit from query params, default 100, max 2000
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit), 2000) : 100;
    query += ` ORDER BY overall_rating DESC LIMIT ${limit}`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching players:', error);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

/**
 * GET /api/players/:playerId
 * Get player details with stats
 */
router.get('/:playerId', async (req, res) => {
  try {
    const { playerId } = req.params;
    const { leagueId } = req.query;

    const playerResult = await pool.query(
      'SELECT * FROM players WHERE id = $1',
      [playerId]
    );

    if (playerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }

    const player = playerResult.rows[0];

    // Get contract info if in a league
    if (leagueId) {
      const contractResult = await pool.query(
        `SELECT tr.*, t.name as team_name
         FROM team_rosters tr
         LEFT JOIN teams t ON tr.team_id = t.id
         WHERE tr.player_id = $1 AND tr.league_id = $2`,
        [playerId, leagueId]
      );

      if (contractResult.rows.length > 0) {
        player.contract = contractResult.rows[0];
      }

      // Get stats
      const statsResult = await pool.query(
        `SELECT * FROM player_stats 
         WHERE player_id = $1 AND league_id = $2 
         ORDER BY season DESC`,
        [playerId, leagueId]
      );

      player.career_stats = statsResult.rows;
    }

    res.json(player);
  } catch (error) {
    console.error('Error fetching player:', error);
    res.status(500).json({ error: 'Failed to fetch player' });
  }
});

/**
 * POST /api/players
 * Create a new player (for custom player pools)
 */
router.post('/', async (req, res) => {
  try {
    const {
      name,
      position,
      age,
      overallRating,
      potential,
      draftYear,
      draftClass,
      attributes
    } = req.body;

    const result = await pool.query(
      `INSERT INTO players 
       (name, position, age, overall_rating, potential, draft_year, draft_class, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        name,
        position,
        age || 22,
        overallRating || 75,
        potential || overallRating || 75,
        draftYear,
        draftClass,
        JSON.stringify(attributes || {})
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating player:', error);
    res.status(500).json({ error: 'Failed to create player' });
  }
});

/**
 * POST /api/players/bulk
 * Create multiple players at once (for draft classes)
 */
router.post('/bulk', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { players } = req.body;

    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'Players array is required' });
    }

    await client.query('BEGIN');

    const createdPlayers = [];

    for (const player of players) {
      const result = await client.query(
        `INSERT INTO players 
         (name, position, age, overall_rating, potential, draft_year, draft_class, attributes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          player.name,
          player.position,
          player.age || 22,
          player.overallRating || 75,
          player.potential || player.overallRating || 75,
          player.draftYear,
          player.draftClass,
          JSON.stringify(player.attributes || {})
        ]
      );

      createdPlayers.push(result.rows[0]);
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: `Created ${createdPlayers.length} players`,
      players: createdPlayers
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating players:', error);
    res.status(500).json({ error: 'Failed to create players' });
  } finally {
    client.release();
  }
});

module.exports = router;
