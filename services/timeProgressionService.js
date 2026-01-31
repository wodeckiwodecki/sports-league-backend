const { pool } = require('../database/init');
const { generateGameNarrative, generateDailyStorylines, generatePlayerDevelopment } = require('./aiService');

/**
 * Process all leagues that are due for a day advancement
 */
async function processLeagueDay(io) {
  const client = await pool.connect();
  
  try {
    // Find leagues that need to advance
    const leaguesQuery = await client.query(`
      SELECT l.*, 
             EXTRACT(EPOCH FROM (NOW() - l.last_processed)) / 3600 as hours_since_last
      FROM leagues l
      WHERE EXTRACT(EPOCH FROM (NOW() - l.last_processed)) / 3600 >= (l.time_ratio->>'real_hours')::numeric
    `);

    for (const league of leaguesQuery.rows) {
      await advanceLeagueDay(client, league, io);
    }
  } catch (error) {
    console.error('Error processing league days:', error);
  } finally {
    client.release();
  }
}

/**
 * Advance a single league by the configured number of days
 */
async function advanceLeagueDay(client, league, io) {
  try {
    await client.query('BEGIN');

    const leagueDays = parseInt(league.time_ratio.league_days);
    
    for (let i = 0; i < leagueDays; i++) {
      const newDay = league.current_day + 1;
      
      // Simulate games for this day
      await simulateGamesForDay(client, league.id, league.current_season, newDay, league.sport, io);
      
      // Update player stats
      await updatePlayerStats(client, league.id, league.current_season);
      
      // Generate storylines
      await generateAndSaveStorylines(client, league, newDay, io);
      
      // Check for player development (every 7 days)
      if (newDay % 7 === 0) {
        await processPlayerDevelopment(client, league.id, io);
      }
      
      // Update league day
      await client.query(
        'UPDATE leagues SET current_day = $1 WHERE id = $2',
        [newDay, league.id]
      );

      league.current_day = newDay;
    }

    // Update last processed timestamp
    await client.query(
      'UPDATE leagues SET last_processed = NOW() WHERE id = $1',
      [league.id]
    );

    await client.query('COMMIT');

    // Notify connected clients
    io.to(`league_${league.id}`).emit('league_day_advanced', {
      leagueId: league.id,
      currentDay: league.current_day,
      currentSeason: league.current_season
    });

    console.log(`Advanced league ${league.id} to day ${league.current_day}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Error advancing league ${league.id}:`, error);
    throw error;
  }
}

/**
 * Simulate all scheduled games for a specific day
 */
async function simulateGamesForDay(client, leagueId, season, day, sport, io) {
  // Get scheduled games for this day
  const gamesQuery = await client.query(
    `SELECT g.*, 
            ht.name as home_team_name, at.name as away_team_name
     FROM games g
     JOIN teams ht ON g.home_team_id = ht.id
     JOIN teams at ON g.away_team_id = at.id
     WHERE g.league_id = $1 AND g.season = $2 AND g.day = $3 AND g.status = 'scheduled'`,
    [leagueId, season, day]
  );

  for (const game of gamesQuery.rows) {
    await simulateSingleGame(client, game, sport, io);
  }
}

/**
 * Simulate a single game using AI
 */
async function simulateSingleGame(client, game, sport, io) {
  try {
    // Get rosters
    const homeRosterQuery = await client.query(
      `SELECT p.*, tr.contract_years, tr.contract_salary
       FROM players p
       JOIN team_rosters tr ON p.id = tr.player_id
       WHERE tr.team_id = $1 AND tr.league_id = $2`,
      [game.home_team_id, game.league_id]
    );

    const awayRosterQuery = await client.query(
      `SELECT p.*, tr.contract_years, tr.contract_salary
       FROM players p
       JOIN team_rosters tr ON p.id = tr.player_id
       WHERE tr.team_id = $1 AND tr.league_id = $2`,
      [game.away_team_id, game.league_id]
    );

    const homeTeam = { id: game.home_team_id, name: game.home_team_name };
    const awayTeam = { id: game.away_team_id, name: game.away_team_name };
    const homeRoster = homeRosterQuery.rows;
    const awayRoster = awayRosterQuery.rows;

    // Generate game using AI
    const gameResult = await generateGameNarrative(
      homeTeam,
      awayTeam,
      homeRoster,
      awayRoster,
      { sport }
    );

    // Update game record
    await client.query(
      `UPDATE games 
       SET home_score = $1, away_score = $2, box_score = $3, narrative = $4, status = 'completed'
       WHERE id = $5`,
      [
        gameResult.homeScore,
        gameResult.awayScore,
        JSON.stringify(gameResult.playerStats),
        gameResult.narrative,
        game.id
      ]
    );

    // Update team records
    const homeWon = gameResult.homeScore > gameResult.awayScore;
    await client.query(
      `UPDATE teams SET wins = wins + $1, losses = losses + $2 WHERE id = $3`,
      [homeWon ? 1 : 0, homeWon ? 0 : 1, game.home_team_id]
    );
    await client.query(
      `UPDATE teams SET wins = wins + $1, losses = losses + $2 WHERE id = $3`,
      [homeWon ? 0 : 1, homeWon ? 1 : 0, game.away_team_id]
    );

    // Save player stats to database
    await savePlayerStats(client, gameResult.playerStats, game.league_id, game.season);

    // Emit game result to connected clients
    io.to(`league_${game.league_id}`).emit('game_completed', {
      gameId: game.id,
      homeTeam: game.home_team_name,
      awayTeam: game.away_team_name,
      homeScore: gameResult.homeScore,
      awayScore: gameResult.awayScore,
      highlights: gameResult.highlights
    });

    console.log(`Game completed: ${game.home_team_name} ${gameResult.homeScore} - ${gameResult.awayScore} ${game.away_team_name}`);
  } catch (error) {
    console.error(`Error simulating game ${game.id}:`, error);
  }
}

/**
 * Save individual player stats from a game
 */
async function savePlayerStats(client, playerStats, leagueId, season) {
  const allStats = [...playerStats.home, ...playerStats.away];
  
  for (const stat of allStats) {
    await client.query(
      `INSERT INTO player_stats (player_id, league_id, season, games_played, stats)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (player_id, league_id, season)
       DO UPDATE SET 
         games_played = player_stats.games_played + 1,
         stats = player_stats.stats || $4`,
      [stat.playerId, leagueId, season, JSON.stringify(stat.stats)]
    );
  }
}

/**
 * Update aggregated player stats
 */
async function updatePlayerStats(client, leagueId, season) {
  // This would calculate averages, update overall ratings based on performance, etc.
  // Implementation depends on your specific stat tracking needs
  console.log(`Updated player stats for league ${leagueId}, season ${season}`);
}

/**
 * Generate and save storylines for the day
 */
async function generateAndSaveStorylines(client, league, day, io) {
  try {
    // Get recent games
    const recentGamesQuery = await client.query(
      `SELECT g.*, ht.name as home_team_name, at.name as away_team_name
       FROM games g
       JOIN teams ht ON g.home_team_id = ht.id
       JOIN teams at ON g.away_team_id = at.id
       WHERE g.league_id = $1 AND g.day >= $2 AND g.status = 'completed'
       ORDER BY g.day DESC
       LIMIT 10`,
      [league.id, day - 3]
    );

    // Get teams
    const teamsQuery = await client.query(
      'SELECT * FROM teams WHERE league_id = $1',
      [league.id]
    );

    const storylines = await generateDailyStorylines(
      league,
      teamsQuery.rows,
      recentGamesQuery.rows,
      null
    );

    // Save storylines
    for (const storyline of storylines) {
      await client.query(
        `INSERT INTO storylines (league_id, type, title, content, entities, day, season)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          league.id,
          storyline.type,
          storyline.title,
          storyline.content,
          JSON.stringify(storyline.entities),
          day,
          league.current_season
        ]
      );
    }

    // Emit storylines to connected clients
    if (storylines.length > 0) {
      io.to(`league_${league.id}`).emit('new_storylines', {
        leagueId: league.id,
        day,
        storylines
      });
    }
  } catch (error) {
    console.error('Error generating storylines:', error);
  }
}

/**
 * Process player development updates
 */
async function processPlayerDevelopment(client, leagueId, io) {
  try {
    // Get all players in the league with recent stats
    const playersQuery = await client.query(
      `SELECT p.*, ps.stats as recent_stats
       FROM players p
       JOIN team_rosters tr ON p.id = tr.player_id
       LEFT JOIN player_stats ps ON p.id = ps.player_id AND ps.league_id = tr.league_id
       WHERE tr.league_id = $1`,
      [leagueId]
    );

    const updates = await generatePlayerDevelopment(playersQuery.rows, { leagueId });

    for (const update of updates) {
      if (update.overallChange !== 0) {
        await client.query(
          'UPDATE players SET overall_rating = overall_rating + $1 WHERE id = $2',
          [update.overallChange, update.playerId]
        );

        // Emit development update
        io.to(`league_${leagueId}`).emit('player_development', {
          playerId: update.playerId,
          change: update.overallChange,
          reason: update.reason
        });
      }
    }

    console.log(`Processed player development for league ${leagueId}: ${updates.length} updates`);
  } catch (error) {
    console.error('Error processing player development:', error);
  }
}

module.exports = {
  processLeagueDay,
  advanceLeagueDay
};
