# Multiplayer Sports League - NEW FEATURES 🔥

## What's New

### 🏀 MLB Support
- Full MLB player database integration via `https://statsapi.mlb.com/api/v1/`
- Import players from any historical season (2000+)
- MLB draft class imports
- Baseball-specific stats (batting avg, HR, RBI, ERA, strikeouts, etc.)

### 👥 Multiplayer System
- **League Invitations**: Invite friends by email to join your league
- **Commissioner Role**: Full control over league settings and progression
- **Multi-User Teams**: Each player controls their own team
- **Real-time Updates**: WebSocket support for draft picks and league events

### ⚙️ Enhanced League Creation
- **Sport Selection**: Choose NBA or MLB
- **Player Pool Options**:
  - All Active Players (current season)
  - Historical Season (any year)
  - Draft Class (specific draft year)
  - Custom (import your own players)
- **Customizable Settings**:
  - Salary cap & luxury tax
  - Draft type (snake/linear)
  - Number of draft rounds
  - Season length
  - Playoff format

### 📊 League Management
- Activity feed tracking all league events
- Team roster management
- Commissioner dashboard with admin controls
- Invitation management system

## API Endpoints

### Multiplayer Leagues (`/api/leagues-v2`)
```
POST   /create-multiplayer          Create new multiplayer league
GET    /:id/details                 Get comprehensive league details
PATCH  /:id/settings                Update league settings (commissioner only)
POST   /:id/import-players          Import players based on settings
GET    /:id/activity                Get league activity feed
```

### Invitations (`/api/invitations`)
```
POST   /send                        Send league invitation
GET    /my-invitations              Get invitations for current user
POST   /:id/respond                 Accept/decline invitation
GET    /league/:leagueId            Get all invitations for a league
DELETE /:id                         Cancel invitation
```

## Database Schema Changes

### New Tables
- `league_invitations` - Track league invites
- `league_activity` - Activity feed for leagues
- `draft_picks` - Track draft picks and trades
- `draft_state` - Live draft progression state
- `commissioner_actions` - Audit log for commissioner actions
- `notifications` - User notifications

### Updated Tables
- `leagues` - Added: sport, league_settings, commissioner_user_id, status, max_teams
- `players` - Added: sport, mlb_stats, historical_year, draft_class
- `teams` - Added: user_id, is_ai_controlled

## Usage Example

### 1. Create Multiplayer League
```javascript
POST /api/leagues-v2/create-multiplayer
{
  "name": "Jordan's League",
  "sport": "MLB",
  "maxTeams": 12,
  "settings": {
    "playerPool": "historical_season",
    "historicalYear": 2023,
    "salaryCap": 200000000,
    "draftType": "snake",
    "draftRounds": 40
  }
}
```

### 2. Import Players
```javascript
POST /api/leagues-v2/:leagueId/import-players
// Will import players based on league settings
// For MLB 2023 season: ~800+ players
```

### 3. Invite Friends
```javascript
POST /api/invitations/send
{
  "leagueId": 1,
  "inviteeEmail": "friend@example.com"
}
```

### 4. Friend Accepts Invitation
```javascript
POST /api/invitations/:invitationId/respond
{
  "accept": true
}
// Friend automatically gets assigned a team
```

## Environment Variables

Add these to your Railway backend:
```
JWT_SECRET=your-secret-key-here
ANTHROPIC_API_KEY=your-anthropic-key-here
```

## Next Steps

1. **Test the endpoints** using Postman or curl
2. **Build frontend UI** for league creation wizard
3. **Add live draft interface** with WebSocket updates
4. **Implement commissioner dashboard**
5. **Add team management pages**

## Notes

- All new endpoints require authentication (Bearer token)
- Commissioner-only endpoints check user permissions
- MLB API calls are rate-limited (100ms between requests)
- Draft system supports both snake and linear formats
- Activity feed tracks all major league events

---

Built with ❤️ for Jordan's custom sports league simulator
