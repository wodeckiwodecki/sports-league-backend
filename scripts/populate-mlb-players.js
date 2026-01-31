const axios = require('axios');
const { pool } = require('../database/init');

const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';

async function populateMLBPlayers() {
  console.log('🚀 Starting MLB player population...');
  
  try {
    // Get all teams
    const teamsResponse = await axios.get(`${MLB_API_BASE}/teams`, {
      params: { sportId: 1, season: 2026 }
    });
    
    const teams = teamsResponse.data.teams || [];
    console.log(`Found ${teams.length} teams`);
    
    let allPlayers = [];
    
    // Fetch rosters for each team
    for (const team of teams) {
      console.log(`Fetching roster for ${team.name}...`);
      
      try {
        const rosterResponse = await axios.get(`${MLB_API_BASE}/teams/${team.id}/roster`, {
          params: { rosterType: 'active', season: 2026 }
        });
        
        const roster = rosterResponse.data.roster || [];
        
        for (const entry of roster) {
          const player = entry.person;
          const position = entry.position.abbreviation;
          
          // Get detailed player info
          try {
            const playerResponse = await axios.get(`${MLB_API_BASE}/people/${player.id}`);
            const playerData = playerResponse.data.people[0];
            
            allPlayers.push({
              external_id: `mlb_${player.id}`,
              name: playerData.fullName,
              sport: 'MLB',
              position: position,
              age: playerData.currentAge || 25,
              team: team.name,
              height: playerData.height || null,
              weight: playerData.weight || null,
              birth_date: playerData.birthDate || null,
              overall_rating: 75
            });
          } catch (err) {
            console.log(`  ⚠️ Skipping ${player.fullName} - error fetching details`);
          }
        }
      } catch (err) {
        console.log(`  ⚠️ Error fetching roster for ${team.name}`);
      }
    }
    
    console.log(`\n📊 Fetched ${allPlayers.length} total players`);
    console.log('💾 Inserting into database...\n');
    
    // Insert players into database
    const client = await pool.connect();
    let inserted = 0;
    
    try {
      await client.query('BEGIN');
      
      for (const player of allPlayers) {
        try {
          const existing = await client.query(
            'SELECT id FROM players WHERE external_id = $1',
            [player.external_id]
          );
          
          if (existing.rows.length === 0) {
            await client.query(
              `INSERT INTO players (
                external_id, name, sport, position, age, overall_rating,
                team, height, weight, birth_date
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                player.external_id,
                player.name,
                player.sport,
                player.position,
                player.age,
                player.overall_rating,
                player.team,
                player.height,
                player.weight,
                player.birth_date
              ]
            );
            inserted++;
            
            if (inserted % 100 === 0) {
              console.log(`  ✅ Inserted ${inserted} players...`);
            }
          }
        } catch (err) {
          console.error(`  ❌ Error inserting ${player.name}:`, err.message);
        }
      }
      
      await client.query('COMMIT');
      console.log(`\n🎉 Successfully imported ${inserted} players!`);
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

populateMLBPlayers();
