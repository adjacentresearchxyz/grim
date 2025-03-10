# Grim: Global Risk Simulator

A Telegram bot for simulating and role-playing global risk scenarios. Players can take on different roles and interact with scenarios through actions and information sharing. You can read more about the motivation behind it here: [Scaling Wargaming for Global Catastrophic Risks with AI](https://blog.sentinel-team.org/p/scaling-wargaming-for-global-catastrophic-risks).

## Getting Started (Local Development)

1. Clone this repository
2. Install dependencies: with `bun install`
3. Create a `.env` file with the following tokens:

```
TELEGRAM_BOT_TOKEN=your_key
ANTHROPIC_API_KEY=your_key
```

You can get an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/), which provides access to Claude Sonnet 3.7, the model used by this application. You can get a Telegram bot token by following instructions [here](https://core.telegram.org/bots#how-do-i-create-a-bot) (messaging the @BotFather account on Telegram.)

## Local Usage

1. Start the bot: `bun src/grim.ts`. Optionally, you can provide a scenario file, `bun src/grim.ts --scenario-file file_name`. There is an example scenario file called `scenario.example.txt` if you want to get up and running quickly.
2. Set your role with `/role <Your Name> - <Your Role>`
3. Start the scenario with `/scenario <scenario_description>`. You don't need to provide `scenario_description` if you used a `scenario_file`
4. Once the scenario is started, you can use these commands:
   - `/info` - Queue an information request about the current situation
   - `/feed` - Queue information to incorporate into the world state
   - `/action` - Queue an action you want to take in the world
   - `/process` - Process all queued actions
   - `/remove` - Remove an item from the action queue
   - `/rollback` - Roll back the scenario to a previous checkpoint

## Cloudflare Worker Deployment

This branch (`cloudflare-worker`) contains a version of GRIM adapted to run on Cloudflare Workers with KV storage for session persistence.

### Prerequisites

1. A Cloudflare account
2. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
3. A Telegram Bot Token (obtain from [@BotFather](https://t.me/BotFather))
4. An Anthropic API Key (for Claude)

### Setup

1. **Login to Cloudflare via Wrangler**:
   ```
   wrangler login
   ```

2. **Create a KV Namespace**:
   ```
   wrangler kv:namespace create GRIM_SESSIONS
   wrangler kv:namespace create GRIM_SESSIONS --preview
   ```
   
   After running these commands, you'll receive KV namespace IDs. Copy these IDs and update the `wrangler.toml` file with them.

3. **Configure Environment Variables**:
   Update the `wrangler.toml` file with your environment variables:
   ```toml
   [vars]
   TELEGRAM_BOT_TOKEN = "your_telegram_bot_token"
   ANTHROPIC_API_KEY = "your_anthropic_api_key"
   ```
   
   For production, you should use Cloudflare's encrypted environment variables:
   ```
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler secret put ANTHROPIC_API_KEY
   ```

### Deployment

1. **Test Locally**:
   ```
   npm run dev
   ```
   
   This runs the worker locally for testing.

2. **Deploy to Cloudflare**:
   ```
   npm run deploy
   ```
   
   After deployment, you'll receive a URL for your worker (e.g., `https://grim.your-username.workers.dev`).

3. **Set Up the Webhook**:
   Visit the setup URL in your browser:
   ```
   https://grim.your-username.workers.dev/setup
   ```
   
   This will configure your Telegram bot to receive updates via Cloudflare Workers.

### API Endpoints

- `GET /setup` - Set up the Telegram webhook
- `GET /remove-webhook` - Remove the Telegram webhook
- `POST /preload-scenario` - Upload a scenario to be used as default
- `POST /webhook` - Telegram webhook endpoint (used by Telegram to send updates)
- `GET /health` - Health check endpoint

### Preloading a Scenario

You can preload a scenario by sending a POST request to the `/preload-scenario` endpoint with the scenario text in the request body:

```bash
curl -X POST https://grim.your-username.workers.dev/preload-scenario \
  -H "Content-Type: text/plain" \
  --data-binary "@scenario.txt"
```

### Notes on Cloudflare Worker Limitations

- Cloudflare Workers have a CPU time limit of 50ms - 10ms (depending on your plan)
- There is a memory limit of 128MB
- KV storage operations have some latency, which may affect response times
- Long-running operations may be terminated - make sure your LLM calls complete within the time limits

## Contributing

We're happy to do some hand-holding to onboard a contributer who may want to contribute consistently! Feel free to ask for clarification in any of the outstanding issues or [request a call](mailto:hello@sentinel-team.org). If you request a call, quickly describe your background or provide a link to your work. Otherwise, feel free to fork the repo, make pull requests, or make issues suggesting improvements. 

## License

Distributed under the GPL. If this is a hurdle for you, let us know.
