# Flipmode - BJJ Training Companion for Obsidian

Document your training, submit research queries to your analyst, and level up your game.

## Quick Start (5 minutes)

### 1. Install Obsidian
- Download from [obsidian.md](https://obsidian.md) (free)
- Install on your phone or computer
- Create a new vault called "Flipmode"

### 2. Install the Plugin

**Option A: Via BRAT (Recommended)**
1. In Obsidian, go to Settings > Community Plugins
2. Turn off "Restricted Mode"
3. Click "Browse" and search for "BRAT"
4. Install and enable BRAT
5. Go to BRAT settings
6. Click "Add Beta Plugin"
7. Enter: `samOrbs/flipmode`
8. Click "Add Plugin"
9. Go back to Community Plugins and enable "Flipmode"

**Option B: Manual Install**
1. Download `main.js`, `manifest.json`, `styles.css` from [Releases](https://github.com/samOrbs/flipmode/releases)
2. In your vault, create folder: `.obsidian/plugins/flipmode/`
3. Copy the 3 files into that folder
4. Restart Obsidian
5. Enable "Flipmode" in Settings > Community Plugins

### 3. Connect Your Account

1. Open Flipmode settings (Settings > Flipmode)
2. Set **Mode** to "Remote (Athlete)"
3. The Queue Service URL should already be set to: `https://flipmode-d2c51311485b.herokuapp.com`
4. Click **"Connect with Discord"**
5. A browser window opens - log in with Discord
6. Authorize the Flipmode app
7. You'll see a success page with your token
8. Copy the token and paste it into the **"Athlete Token"** field in settings
9. Click the **"Test Connection"** button to verify

**Note:** Your analyst must add your Discord ID to their roster before you can connect. Ask them to add you first.

## Using Flipmode

### Log Training Sessions
- Click the Flipmode icon in the left ribbon
- Or use Command Palette: "Flipmode: Log Training Session"
- Fill in your training details:
  - Date and gym
  - Techniques worked
  - Rounds and outcomes
  - Notes and reflections
- Sessions are saved and synced automatically

### Submit Research Queries
- Create a new note for your research topic
- Build your question using the conversation tools
- When ready, click **"Send to Analyst"**
- Your query goes to your analyst's queue
- Check back later for results - you'll get a notification

### View Results
- Results appear in your Flipmode/Research folder
- Each response includes:
  - Detailed technique breakdown
  - Video sources and timestamps
  - Follow-up suggestions

## Folder Structure

The plugin organizes your vault automatically:

```
Your Vault/
├── Flipmode/
│   ├── Sessions/           # Training logs
│   ├── Research/           # Query results
│   ├── Conversations/      # Research threads
│   └── Templates/          # Auto-created templates
```

## Troubleshooting

**"Not registered with any coach"**
- Your analyst needs to add your Discord ID to their roster first
- Contact your analyst and ask them to add you

**Connection failed**
- Check your internet connection
- Verify the Queue Service URL is correct
- Try the "Test Connection" button

**Plugin not showing**
- Make sure "Restricted Mode" is OFF in Community Plugins
- Try restarting Obsidian
- Check that the plugin is enabled

## Requirements

- Obsidian (free) - [obsidian.md](https://obsidian.md)
- Discord account (for authentication)
- Active roster membership (analyst adds you)

## Support

- Issues: [GitHub Issues](https://github.com/samOrbs/flipmode/issues)
- Discord: Contact your analyst

---

Built for the BJJ community.
