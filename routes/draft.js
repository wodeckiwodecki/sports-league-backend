const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const {
  initializeDraft,
  startDraft,
  makeDraftPick,
  makeAIDraftPick,
  processAIDrafts,
  getDraftState
} = require('../services/draftService');

/**
 * POST /api/draft/initialize
 * Initialize a draft for a league
 */
router.post('/initialize', async (req, res) => {
  try {
    const { leagueId, settings } = req.body;

    const draftSettings = {
      rounds: settings?.rounds || 10,
      type: settings?.type || 'snake',
      totalPicks: settings?.totalPicks || 500,
      timePerPick: settings?.timePerPick || 90 // seconds
    };

    const draftState = await initializeDraft(leagueId, draftSettings);

    res.status(201).json({
      message: 'Draft initialized successfully',
      draftState
    });
  } catch (error) {
    console.error('Error initializing draft:', error);
    res.status(500).json({ error: error.message || 'Failed to initialize draft' });
  }
});

/**
 * POST /api/draft/start
 * Start a draft
 */
router.post('/start', async (req, res) => {
  try {
    const { leagueId } = req.body;

    const draftState = await startDraft(leagueId);

    // Start auto-drafting for AI teams
    const io = req.app.get('io');
    setTimeout(() => processAIDrafts(leagueId, io), 1000);

    // Emit to all connected clients
    io.to(`league_${leagueId}`).emit('draft_started', {
      leagueId,
      currentPick: draftState.current_pick
    });

    res.json({
      message: 'Draft started',
      draftState
    });
  } catch (error) {
    console.error('Error starting draft:', error);
    res.status(500).json({ error: error.message || 'Failed to start draft' });
  }
});

/**
 * POST /api/draft/pick
 * Make a draft pick
 */
router.post('/pick', async (req, res) => {
  try {
    const { leagueId, teamId, playerId } = req.body;

    const io = req.app.get('io');
    const result = await makeDraftPick(leagueId, teamId, playerId, io);

    // Continue AI drafting if next pick is AI
    setTimeout(() => processAIDrafts(leagueId, io), 1000);

    res.json({
      message: 'Pick made successfully',
      pick: result.pick,
      currentPick: result.draftState.current_pick,
      status: result.draftState.status
    });
  } catch (error) {
    console.error('Error making draft pick:', error);
    res.status(500).json({ error: error.message || 'Failed to make pick' });
  }
});

/**
 * GET /api/draft/:leagueId
 * Get current draft state
 */
router.get('/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;

    const draftState = await getDraftState(leagueId);

    if (!draftState) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    res.json(draftState);
  } catch (error) {
    console.error('Error fetching draft state:', error);
    res.status(500).json({ error: 'Failed to fetch draft state' });
  }
});

/**
 * GET /api/draft/:leagueId/available-players
 * Get available players for the draft
 */
router.get('/:leagueId/available-players', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { position, search, limit = 50, offset = 0 } = req.query;

    const draftState = await getDraftState(leagueId);

    if (!draftState) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    let query = `
      SELECT * FROM players 
      WHERE id = ANY($1)
    `;

    const params = [draftState.available_players];
    let paramCount = 2;

    if (position) {
      query += ` AND position = $${paramCount}`;
      params.push(position);
      paramCount++;
    }

    if (search) {
      query += ` AND name ILIKE $${paramCount}`;
      params.push(`%${search}%`);
      paramCount++;
    }

    query += ` ORDER BY overall_rating DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    res.json({
      players: result.rows,
      total: draftState.available_players.length,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching available players:', error);
    res.status(500).json({ error: 'Failed to fetch available players' });
  }
});

/**
 * GET /api/draft/:leagueId/team/:teamId/picks
 * Get a team's draft picks
 */
router.get('/:leagueId/team/:teamId/picks', async (req, res) => {
  try {
    const { leagueId, teamId } = req.params;

    const draftState = await getDraftState(leagueId);

    if (!draftState) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    const team = draftState.teams.find(t => t.id === parseInt(teamId));

    if (!team) {
      return res.status(404).json({ error: 'Team not found in draft' });
    }

    res.json({
      teamName: team.name,
      picks: team.picks
    });
  } catch (error) {
    console.error('Error fetching team picks:', error);
    res.status(500).json({ error: 'Failed to fetch team picks' });
  }
});

/**
 * GET /api/draft/:leagueId/upcoming-picks/:teamId
 * Get a team's upcoming picks
 */
router.get('/:leagueId/upcoming-picks/:teamId', async (req, res) => {
  try {
    const { leagueId, teamId } = req.params;

    const draftState = await getDraftState(leagueId);

    if (!draftState) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    const upcomingPicks = draftState.draft_order
      .filter(pick => 
        pick.team_id === parseInt(teamId) && 
        pick.pick >= draftState.current_pick
      )
      .slice(0, 5); // Next 5 picks

    res.json(upcomingPicks);
  } catch (error) {
    console.error('Error fetching upcoming picks:', error);
    res.status(500).json({ error: 'Failed to fetch upcoming picks' });
  }
});

/**
 * POST /api/draft/:leagueId/auto-pick
 * Auto-pick for a human team (BPA)
 */
router.post('/:leagueId/auto-pick', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { teamId } = req.body;

    const io = req.app.get('io');
    const result = await makeAIDraftPick(leagueId, teamId, io);

    // Continue AI drafting if next pick is AI
    setTimeout(() => processAIDrafts(leagueId, io), 1000);

    res.json({
      message: 'Auto-pick made successfully',
      pick: result.pick,
      currentPick: result.draftState.current_pick,
      status: result.draftState.status
    });
  } catch (error) {
    console.error('Error making auto-pick:', error);
    res.status(500).json({ error: error.message || 'Failed to make auto-pick' });
  }
});

/**
 * GET /api/draft/:leagueId/draft-board
 * Get best available players (draft board view)
 */
router.get('/:leagueId/draft-board', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { limit = 100 } = req.query;

    const draftState = await getDraftState(leagueId);

    if (!draftState) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    const result = await pool.query(
      `SELECT * FROM players 
       WHERE id = ANY($1)
       ORDER BY overall_rating DESC, potential DESC
       LIMIT $2`,
      [draftState.available_players, limit]
    );

    // Group by position
    const byPosition = {
      PG: [],
      SG: [],
      SF: [],
      PF: [],
      C: []
    };

    result.rows.forEach(player => {
      if (byPosition[player.position]) {
        byPosition[player.position].push(player);
      }
    });

    res.json({
      overall: result.rows,
      byPosition,
      totalAvailable: draftState.available_players.length
    });
  } catch (error) {
    console.error('Error fetching draft board:', error);
    res.status(500).json({ error: 'Failed to fetch draft board' });
  }
});

module.exports = router;
