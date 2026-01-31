const express = require('express');
const router = express.Router();
const { 
  importNBAPlayers, 
  searchNBAPlayers,
  getPlayersByTeam 
} = require('../services/nbaApiService');

/**
 * POST /api/nba/import
 * Import all NBA players from the API into the database
 */
router.post('/import', async (req, res) => {
  try {
    console.log('Starting NBA player import...');
    
    const result = await importNBAPlayers();

    res.json({
      message: 'NBA players imported successfully',
      imported: result.imported,
      skipped: result.skipped,
      total: result.total
    });
  } catch (error) {
    console.error('Error importing NBA players:', error);
    res.status(500).json({ 
      error: 'Failed to import NBA players',
      details: error.message 
    });
  }
});

/**
 * GET /api/nba/search
 * Search NBA players from the API
 */
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Search query required' });
    }

    const players = await searchNBAPlayers(q);

    res.json({
      players,
      count: players.length
    });
  } catch (error) {
    console.error('Error searching NBA players:', error);
    res.status(500).json({ error: 'Failed to search NBA players' });
  }
});

/**
 * GET /api/nba/teams/:teamId/players
 * Get players by NBA team
 */
router.get('/teams/:teamId/players', async (req, res) => {
  try {
    const { teamId } = req.params;

    const players = await getPlayersByTeam(teamId);

    res.json({
      players,
      count: players.length
    });
  } catch (error) {
    console.error('Error fetching team players:', error);
    res.status(500).json({ error: 'Failed to fetch team players' });
  }
});

module.exports = router;
