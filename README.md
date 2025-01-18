# Grim: Global Risk Simulator

A Telegram bot for simulating and role-playing global risk scenarios. Players can take on different roles and interact with scenarios through actions and information sharing.

## Setup

1. Clone this repository
2. Install dependencies: with `bun install`
3. Create a `.env` file with relevant tokens:

```
TELEGRAM_BOT_TOKEN=your_key
OPENAI_API_KEY=your_key
```

You can get an OpenAI key from [platform.openai.com/settings](https://platform.openai.com/settings), and a Telegram bot token by following instructions [here](https://core.telegram.org/bots#how-do-i-create-a-bot) (messaging the @BotFather account on Telegram.)

### Usage

1. Start the bot
   ```bash
   bun src/grim.ts [--scenario-file <file_name>]
   ```
1. Set your role with `/role <Your Name> - <Your Role>`
1. Start the scenario with `/scenario <scenario_description>`. You don't need to provide `scenario_description` if you used a `scenario_file`
1. Once the scenario is started, you can use these commands:
- `/info` - Queue an information request about the current situation
- `/feed` - Queue information to incorporate into the world state
- `/action` - Queue an action you want to take in the world
- `/process` - Process all queued actions
- `/remove` - Remove an item from the action queue
- `/rollback` - Roll back the scenario to a previous checkpoint

