const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

/**
 * GET /api/games/league/:leagueId
 * Get all games for a league
 */
router.get('/league/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { season, status, teamId } = req.query;

    let query = `
      SELECT g.*, 
             ht.name as home_team_name, ht.abbreviation as home_team_abbr,
             at.name as away_team_name, at.abbreviation as away_team_abbr
      FROM games g
      JOIN teams ht ON g.home_team_id = ht.id
      JOIN teams at ON g.away_team_id = at.id
      WHERE g.league_id = $1
    `;

    const params = [leagueId];
    let paramCount = 2;

    if (season) {
      query += ` AND g.season = $${paramCount}`;
      params.push(season);
      paramCount++;
    }

    if (status) {
      query += ` AND g.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    if (teamId) {
      query += ` AND (g.home_team_id = $${paramCount} OR g.away_team_id = $${paramCount})`;
      params.push(teamId);
      paramCount++;
    }

    query += ' ORDER BY g.season DESC, g.day DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching games:', error);
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

/**
 * GET /api/games/:gameId
 * Get detailed game information
 */
router.get('/:gameId', async (req, res) => {
  try {
    const { gameId } = req.params;

    const result = await pool.query(
      `SELECT g.*, 
              ht.name as home_team_name, ht.abbreviation as home_team_abbr,
              at.name as away_team_name, at.abbreviation as away_team_abbr
       FROM games g
       JOIN teams ht ON g.home_team_id = ht.id
       JOIN teams at ON g.away_team_id = at.id
       WHERE g.id = $1`,
      [gameId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Game not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching game:', error);
    res.status(500).json({ error: 'Failed to fetch game' });
  }
});

/**
 * POST /api/games/schedule
 * Create a game schedule for a league
 */
router.post('/schedule', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { leagueId, season, gamesPerTeam } = req.body;

    await client.query('BEGIN');

    // Get all teams in the league
    const teamsResult = await client.query(
      'SELECT id FROM teams WHERE league_id = $1',
      [leagueId]
    );

    const teams = teamsResult.rows;

    if (teams.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 teams to create a schedule' });
    }

    // Simple round-robin scheduling
    const games = [];
    let currentDay = 1;

    for (let round = 0; round < gamesPerTeam; round++) {
      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          // Alternate home/away
          const homeTeam = round % 2 === 0 ? teams[i].id : teams[j].id;
          const awayTeam = round % 2 === 0 ? teams[j].id : teams[i].id;

          games.push({
            leagueId,
            season,
            homeTeamId: homeTeam,
            awayTeamId: awayTeam,
            day: currentDay
          });

          // Increment day every few games to spread out the schedule
          if (games.length % Math.floor(teams.length / 2) === 0) {
            currentDay++;
          }
        }
      }
    }

    // Insert games
    for (const game of games) {
      await client.query(
        `INSERT INTO games (league_id, home_team_id, away_team_id, season, day, status)
         VALUES ($1, $2, $3, $4, $5, 'scheduled')`,
        [game.leagueId, game.homeTeamId, game.awayTeamId, game.season, game.day]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Schedule created successfully',
      gamesCreated: games.length,
      totalDays: currentDay
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating schedule:', error);
    res.status(500).json({ error: 'Failed to create schedule' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/games/today/:leagueId
 * Get today's games for a league
 */
router.get('/today/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;

    // Get current day from league
    const leagueResult = await pool.query(
      'SELECT current_day, current_season FROM leagues WHERE id = $1',
      [leagueId]
    );

    if (leagueResult.rows.length === 0) {
      return res.status(404).json({ error: 'League not found' });
    }

    const { current_day, current_season } = leagueResult.rows[0];

    const result = await pool.query(
      `SELECT g.*, 
              ht.name as home_team_name, ht.abbreviation as home_team_abbr,
              at.name as away_team_name, at.abbreviation as away_team_abbr
       FROM games g
       JOIN teams ht ON g.home_team_id = ht.id
       JOIN teams at ON g.away_team_id = at.id
       WHERE g.league_id = $1 AND g.season = $2 AND g.day = $3
       ORDER BY g.id`,
      [leagueId, current_season, current_day]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching today\'s games:', error);
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

/**
 * GET /api/games/standings/:leagueId
 * Get league standings
 */
router.get('/standings/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { season } = req.query;

    const result = await pool.query(
      `SELECT t.*,
              (t.wins::float / NULLIF(t.wins + t.losses, 0)) as win_percentage
       FROM teams t
       WHERE t.league_id = $1
       ORDER BY win_percentage DESC NULLS LAST, t.wins DESC`,
      [leagueId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching standings:', error);
    res.status(500).json({ error: 'Failed to fetch standings' });
  }
});

module.exports = router;
