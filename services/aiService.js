const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Generate game narrative and stats for a matchup
 */
async function generateGameNarrative(homeTeam, awayTeam, homeRoster, awayRoster, gameContext) {
  const prompt = `You are simulating an ${gameContext.sport} game between ${homeTeam.name} (home) and ${awayTeam.name} (away).

Home Team Roster:
${homeRoster.map(p => `- ${p.name} (${p.position}, Overall: ${p.overall_rating})`).join('\n')}

Away Team Roster:
${awayRoster.map(p => `- ${p.name} (${p.position}, Overall: ${p.overall_rating})`).join('\n')}

Generate a realistic game simulation with:
1. Final score
2. Individual player statistics (realistic based on their overall ratings)
3. A 3-4 paragraph narrative describing the key moments of the game
4. Game highlights (3-5 key plays or moments)

Format your response as JSON:
{
  "homeScore": number,
  "awayScore": number,
  "narrative": "detailed game story",
  "highlights": ["highlight 1", "highlight 2", ...],
  "playerStats": {
    "home": [{"playerId": id, "name": "name", "stats": {...}}],
    "away": [{"playerId": id, "name": "name", "stats": {...}}]
  }
}

For ${gameContext.sport === 'NBA' ? 'basketball' : 'baseball'}, include appropriate stats like ${gameContext.sport === 'NBA' ? 'points, rebounds, assists, steals, blocks, FG%, 3P%, FT%' : 'hits, runs, RBIs, home runs, stolen bases, batting average, ERA for pitchers'}.

Make the stats realistic - star players (90+ overall) should have better performances, but allow for upsets and variance.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    
    // Extract JSON from response (handle markdown code blocks)
    let jsonText = responseText;
    if (responseText.includes('```json')) {
      jsonText = responseText.match(/```json\n([\s\S]*?)\n```/)?.[1] || responseText;
    } else if (responseText.includes('```')) {
      jsonText = responseText.match(/```\n([\s\S]*?)\n```/)?.[1] || responseText;
    }
    
    return JSON.parse(jsonText.trim());
  } catch (error) {
    console.error('Error generating game narrative:', error);
    throw error;
  }
}

/**
 * Generate daily storylines for the league
 */
async function generateDailyStorylines(league, teams, recentGames, leagueContext) {
  const prompt = `You are generating daily storylines for a ${league.sport} league on Day ${league.current_day}, Season ${league.current_season}.

League: ${league.name}
Teams: ${teams.map(t => `${t.name} (${t.wins}-${t.losses})`).join(', ')}

Recent Games:
${recentGames.map(g => `${g.home_team_name} ${g.home_score} - ${g.away_score} ${g.away_team_name}`).join('\n')}

${leagueContext ? `Context: ${leagueContext}` : ''}

Generate 2-4 interesting storylines that could emerge. These could be:
- Player performance trends or breakouts
- Team winning/losing streaks
- Rivalries developing
- Injury reports
- Trade rumors
- Coaching decisions
- Playoff implications

Format as JSON array:
[
  {
    "type": "player_news|team_news|rivalry|injury|trade_rumor|other",
    "title": "catchy headline",
    "content": "2-3 paragraph story",
    "entities": {"teams": [], "players": []}
  }
]

Make storylines engaging and realistic for a sports league simulation.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    let jsonText = responseText;
    if (responseText.includes('```json')) {
      jsonText = responseText.match(/```json\n([\s\S]*?)\n```/)?.[1] || responseText;
    } else if (responseText.includes('```')) {
      jsonText = responseText.match(/```\n([\s\S]*?)\n```/)?.[1] || responseText;
    }
    
    return JSON.parse(jsonText.trim());
  } catch (error) {
    console.error('Error generating storylines:', error);
    return [];
  }
}

/**
 * Evaluate a trade proposal
 */
async function evaluateTradeProposal(trade, proposingTeam, receivingTeam, offeringPlayers, requestingPlayers) {
  const prompt = `Evaluate this trade proposal:

Proposing Team: ${proposingTeam.name}
Offering: ${offeringPlayers.map(p => `${p.name} (${p.position}, Overall: ${p.overall_rating}, ${p.contract_years}yr/$${(p.contract_salary/1000000).toFixed(1)}M)`).join(', ')}

Receiving Team: ${receivingTeam.name}
Requesting: ${requestingPlayers.map(p => `${p.name} (${p.position}, Overall: ${p.overall_rating}, ${p.contract_years}yr/$${(p.contract_salary/1000000).toFixed(1)}M)`).join(', ')}

Provide a brief evaluation (2-3 sentences) from the perspective of the receiving team's GM. Consider:
- Player value and fit
- Contract considerations
- Team needs
- Overall fairness

Also rate the likelihood they would accept (0-100).

Format as JSON:
{
  "evaluation": "GM's thoughts on the trade",
  "acceptanceLikelihood": number (0-100),
  "recommendation": "accept|decline|counter"
}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    let jsonText = responseText;
    if (responseText.includes('```json')) {
      jsonText = responseText.match(/```json\n([\s\S]*?)\n```/)?.[1] || responseText;
    } else if (responseText.includes('```')) {
      jsonText = responseText.match(/```\n([\s\S]*?)\n```/)?.[1] || responseText;
    }
    
    return JSON.parse(jsonText.trim());
  } catch (error) {
    console.error('Error evaluating trade:', error);
    return {
      evaluation: "Unable to evaluate at this time.",
      acceptanceLikelihood: 50,
      recommendation: "decline"
    };
  }
}

/**
 * Generate agent response to contract offer
 */
async function generateContractResponse(player, offer, teamContext) {
  const prompt = `You are the agent for ${player.name}, a ${player.age}-year-old ${player.position} with an overall rating of ${player.overall_rating}.

The ${teamContext.teamName} has offered:
- ${offer.years} years
- $${(offer.annual_salary/1000000).toFixed(1)}M per year

Player context:
- Age: ${player.age}
- Overall: ${player.overall_rating}
- Position: ${player.position}
${player.current_stats ? `- Current season stats: ${JSON.stringify(player.current_stats)}` : ''}

Team context:
- Team salary cap space: $${(teamContext.capSpace/1000000).toFixed(1)}M
- Team record: ${teamContext.wins}-${teamContext.losses}

Generate a realistic agent response (2-3 sentences) considering:
- Player's value in the market
- Contract fairness for player's age and skill
- Team's situation
- Player's career stage

Also decide if they would accept.

Format as JSON:
{
  "response": "agent's message",
  "willAccept": boolean,
  "counterOffer": {"years": number, "annualSalary": number} or null
}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    let jsonText = responseText;
    if (responseText.includes('```json')) {
      jsonText = responseText.match(/```json\n([\s\S]*?)\n```/)?.[1] || responseText;
    } else if (responseText.includes('```')) {
      jsonText = responseText.match(/```\n([\s\S]*?)\n```/)?.[1] || responseText;
    }
    
    return JSON.parse(jsonText.trim());
  } catch (error) {
    console.error('Error generating contract response:', error);
    return {
      response: "We'll consider this offer and get back to you.",
      willAccept: false,
      counterOffer: null
    };
  }
}

/**
 * Generate player development/regression updates
 */
async function generatePlayerDevelopment(players, leagueContext) {
  const prompt = `Generate realistic player development updates for the following players based on their age, performance, and potential:

${players.map(p => `- ${p.name}: Age ${p.age}, Overall ${p.overall_rating}, Potential ${p.potential}, Recent stats: ${JSON.stringify(p.recent_stats || {})}`).join('\n')}

Consider:
- Young players (under 25) can improve if performing well
- Prime players (25-29) remain stable or slightly improve
- Veterans (30+) may decline
- Performance impacts development

Return JSON array of updates:
[
  {
    "playerId": number,
    "overallChange": number (-3 to +3),
    "reason": "brief explanation"
  }
]`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    let jsonText = responseText;
    if (responseText.includes('```json')) {
      jsonText = responseText.match(/```json\n([\s\S]*?)\n```/)?.[1] || responseText;
    } else if (responseText.includes('```')) {
      jsonText = responseText.match(/```\n([\s\S]*?)\n```/)?.[1] || responseText;
    }
    
    return JSON.parse(jsonText.trim());
  } catch (error) {
    console.error('Error generating player development:', error);
    return [];
  }
}

module.exports = {
  generateGameNarrative,
  generateDailyStorylines,
  evaluateTradeProposal,
  generateContractResponse,
  generatePlayerDevelopment
};
