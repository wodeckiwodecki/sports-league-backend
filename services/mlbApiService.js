const axios = require('axios');

const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';

class MLBApiService {
  /**
   * Get all teams for a specific season
   */
  async getTeams(season = new Date().getFullYear()) {
    try {
      const response = await axios.get(`${MLB_API_BASE}/teams`, {
        params: {
          sportId: 1, // MLB
          season: season
        }
      });
      return response.data.teams || [];
    } catch (error) {
      console.error('Error fetching MLB teams:', error.message);
      throw error;
    }
  }

  /**
   * Get roster for a specific team and season
   */
  async getTeamRoster(teamId, season = new Date().getFullYear()) {
    try {
      const response = await axios.get(`${MLB_API_BASE}/teams/${teamId}/roster`, {
        params: {
          rosterType: 'active',
          season: season
        }
      });
      return response.data.roster || [];
    } catch (error) {
      console.error(`Error fetching roster for team ${teamId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get detailed player information
   */
  async getPlayerDetails(playerId) {
    try {
      const response = await axios.get(`${MLB_API_BASE}/people/${playerId}`, {
        params: {
          hydrate: 'stats(group=[hitting,pitching],type=[season])'
        }
      });
      return response.data.people?.[0] || null;
    } catch (error) {
      console.error(`Error fetching player ${playerId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get player stats for a specific season
   */
  async getPlayerStats(playerId, season = new Date().getFullYear()) {
    try {
      const response = await axios.get(`${MLB_API_BASE}/people/${playerId}/stats`, {
        params: {
          stats: 'season',
          group: 'hitting,pitching',
          season: season
        }
      });
      return response.data.stats || [];
    } catch (error) {
      console.error(`Error fetching stats for player ${playerId}:`, error.message);
      return [];
    }
  }

  /**
   * Get all players for a specific season with their stats
   */
  async getAllPlayersForSeason(season = new Date().getFullYear()) {
    try {
      console.log(`Fetching all MLB players for season ${season}...`);
      
      // Get all teams
      const teams = await this.getTeams(season);
      console.log(`Found ${teams.length} teams`);
      
      const allPlayers = [];
      
      // For each team, get roster
      for (const team of teams) {
        try {
          const roster = await this.getTeamRoster(team.id, season);
          
          // For each player in roster, get detailed stats
          for (const rosterEntry of roster) {
            try {
              const player = rosterEntry.person;
              const playerDetails = await this.getPlayerDetails(player.id);
              
              if (playerDetails) {
                const formattedPlayer = this.formatPlayerData(playerDetails, team, season);
                allPlayers.push(formattedPlayer);
              }
              
              // Rate limiting: wait 100ms between requests
              await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
              console.error(`Error processing player ${rosterEntry.person.id}:`, error.message);
            }
          }
        } catch (error) {
          console.error(`Error processing team ${team.id}:`, error.message);
        }
      }
      
      console.log(`Successfully fetched ${allPlayers.length} players`);
      return allPlayers;
    } catch (error) {
      console.error('Error fetching all players:', error.message);
      throw error;
    }
  }

  /**
   * Get draft class for a specific year
   */
  async getDraftClass(year) {
    try {
      const response = await axios.get(`${MLB_API_BASE}/draft/${year}`);
      const picks = response.data.drafts?.rounds?.flatMap(round => round.picks || []) || [];
      
      const draftees = [];
      for (const pick of picks.slice(0, 100)) { // First 100 picks
        try {
          if (pick.person?.id) {
            const playerDetails = await this.getPlayerDetails(pick.person.id);
            if (playerDetails) {
              const formattedPlayer = this.formatPlayerData(playerDetails, null, year);
              formattedPlayer.draft_position = pick.pickNumber;
              formattedPlayer.draft_round = pick.round;
              draftees.push(formattedPlayer);
            }
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`Error processing draft pick ${pick.pickNumber}:`, error.message);
        }
      }
      
      return draftees;
    } catch (error) {
      console.error(`Error fetching draft class ${year}:`, error.message);
      throw error;
    }
  }

  /**
   * Format player data for our database
   */
  formatPlayerData(playerDetails, team, season) {
    const stats = playerDetails.stats || [];
    
    // Extract hitting stats
    const hittingStats = stats.find(s => s.group?.displayName === 'hitting')?.splits?.[0]?.stat || {};
    
    // Extract pitching stats
    const pitchingStats = stats.find(s => s.group?.displayName === 'pitching')?.splits?.[0]?.stat || {};
    
    // Determine position
    const primaryPosition = playerDetails.primaryPosition?.abbreviation || 'P';
    
    // Calculate overall rating based on stats
    let overall = 75; // Base rating
    
    if (primaryPosition !== 'P') {
      // Hitter rating
      const avg = parseFloat(hittingStats.avg || 0);
      const hr = parseInt(hittingStats.homeRuns || 0);
      const rbi = parseInt(hittingStats.rbi || 0);
      
      overall = Math.min(99, Math.max(60, Math.round(
        70 + (avg * 100) + (hr / 5) + (rbi / 25)
      )));
    } else {
      // Pitcher rating
      const era = parseFloat(pitchingStats.era || 5.00);
      const wins = parseInt(pitchingStats.wins || 0);
      const strikeouts = parseInt(pitchingStats.strikeOuts || 0);
      
      overall = Math.min(99, Math.max(60, Math.round(
        90 - (era * 3) + (wins * 2) + (strikeouts / 30)
      )));
    }
    
    return {
      external_id: `mlb_${playerDetails.id}`,
      name: playerDetails.fullName,
      sport: 'MLB',
      position: primaryPosition,
      age: playerDetails.currentAge || 25,
      overall_rating: overall,
      team: team?.name || 'Free Agent',
      historical_year: season,
      mlb_stats: {
        batting: {
          avg: parseFloat(hittingStats.avg || 0),
          hr: parseInt(hittingStats.homeRuns || 0),
          rbi: parseInt(hittingStats.rbi || 0),
          sb: parseInt(hittingStats.stolenBases || 0),
          ops: parseFloat(hittingStats.ops || 0),
          hits: parseInt(hittingStats.hits || 0),
          doubles: parseInt(hittingStats.doubles || 0),
          triples: parseInt(hittingStats.triples || 0)
        },
        pitching: {
          era: parseFloat(pitchingStats.era || 0),
          wins: parseInt(pitchingStats.wins || 0),
          losses: parseInt(pitchingStats.losses || 0),
          saves: parseInt(pitchingStats.saves || 0),
          strikeouts: parseInt(pitchingStats.strikeOuts || 0),
          whip: parseFloat(pitchingStats.whip || 0),
          inningsPitched: parseFloat(pitchingStats.inningsPitched || 0)
        }
      },
      height: playerDetails.height || '',
      weight: playerDetails.weight || 0,
      birth_date: playerDetails.birthDate || null
    };
  }

  /**
   * Calculate salary based on stats and position
   */
  calculateSalary(player) {
    const overall = player.overall_rating || 75;
    const isPitcher = player.position === 'P';
    
    // Base salary calculation
    let baseSalary = 500000; // MLB minimum
    
    if (overall >= 90) {
      baseSalary = isPitcher ? 25000000 : 20000000;
    } else if (overall >= 85) {
      baseSalary = isPitcher ? 15000000 : 12000000;
    } else if (overall >= 80) {
      baseSalary = isPitcher ? 8000000 : 7000000;
    } else if (overall >= 75) {
      baseSalary = isPitcher ? 3000000 : 2500000;
    } else {
      baseSalary = 1000000;
    }
    
    // Add randomness (+/- 20%)
    const variance = baseSalary * 0.2;
    const salary = Math.round(baseSalary + (Math.random() * variance * 2 - variance));
    
    return salary;
  }
}

module.exports = new MLBApiService();
