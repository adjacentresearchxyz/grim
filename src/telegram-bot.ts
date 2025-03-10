import { Bot, Context, NextFunction, webhookCallback } from "grammy";
import { SessionData, CloudflareKVStorage, getInitialSessionData } from "./storage";
import { ChatService, DefaultAnthropicClient, ChatCompletionMessageParam } from "./anthropic";
import logger from "./logger";
import crypto from 'crypto';
import { Player, UserInteraction, UserInteractionType } from "./types";

type BotContext = Context & {
  session: SessionData;
};

// Helper function to generate hash for scenario state
const generateStateHash = (state: any): string => {
  const stateString = JSON.stringify(state);
  return crypto.createHash('sha256').update(stateString).digest('hex').slice(0, 8);
};

// Helper function for chunking text
const chunkText = (text: string, maxLength: number): string[] => {
  const findLastNewlineBeforeLimit = (text: string, limit: number): number => {
    const endIndex = Math.min(limit, text.length);
    const searchFrom = text.slice(0, endIndex).lastIndexOf('\n');
    return searchFrom === -1 ? endIndex : searchFrom;
  };

  if (text.length <= maxLength) return [text];

  const splitIndex = findLastNewlineBeforeLimit(text, maxLength);
  const firstChunk = text.slice(0, splitIndex);
  const remainder = text.slice(splitIndex + 1);

  return [firstChunk, ...chunkText(remainder, maxLength)];
};

export class TelegramBot {
  private bot: Bot<BotContext>;
  private chatService: ChatService;
  private storage: CloudflareKVStorage;
  private preloadedScenario: string | undefined;
  
  constructor(
    telegramToken: string, 
    anthropicApiKey: string, 
    kvNamespace: KVNamespace, 
    preloadedScenario?: string
  ) {
    this.bot = new Bot<BotContext>(telegramToken);
    const anthropicClient = new DefaultAnthropicClient(anthropicApiKey);
    this.chatService = new ChatService(anthropicClient);
    this.storage = new CloudflareKVStorage(kvNamespace);
    this.preloadedScenario = preloadedScenario;
    
    this.setupMiddleware();
    this.setupCommands();
  }

  private async reply(ctx: BotContext, message: string) {
    return ctx.reply(message);
  }

  // Helper function to send chunked replies
  private async sendChunkedReply(ctx: BotContext, content: string) {
    const chunks = chunkText(content, 4096);
    for (const chunk of chunks) {
      await this.reply(ctx, chunk);
    }
  }

  // Helper function to save current state
  private saveState(ctx: BotContext) {
    const hash = generateStateHash(ctx.session.scenarioState);
    ctx.session.scenarioCheckpoints.set(hash, JSON.parse(JSON.stringify(ctx.session.scenarioState)));
    return hash;
  }

  // Helper function to format queue for display
  private formatQueue(queue: UserInteraction[]): string {
    if (queue.length === 0) return "Queue is empty";

    return queue.map((action, index) =>
      `${index + 1}. ${action.player.name} - ${action.type}: ${action.content}`
    ).join('\n');
  }

  // Session middleware to get user data from KV
  private async sessionMiddleware(ctx: BotContext, next: NextFunction) {
    // Create a unique key for the chat session
    const sessionKey = `chat_${ctx.chat?.id}`;
    
    try {
      // Retrieve session from KV or create initial session
      let session = await this.storage.get(sessionKey);
      
      if (!session) {
        session = getInitialSessionData();
      }
      
      // Attach session to context
      ctx.session = session;
      
      // Let other middleware and handlers process the update
      await next();
      
      // Save the possibly modified session back to KV
      await this.storage.set(sessionKey, ctx.session);
    } catch (error) {
      logger.error('Session middleware error', { error });
      // Continue to next middleware even if there's an error
      await next();
    }
  }

  // Middleware to check if user has a role
  private async requireRoleMiddleware(ctx: BotContext, next: NextFunction) {
    const userId = ctx.from?.id;
    if (!userId || !ctx.session.roleAssignments.has(userId)) {
      await this.reply(ctx, "You need to select a role first using /role");
      return;
    }
    
    await next();
  }

  // Middleware to check if scenario is active
  private async requireScenarioMiddleware(ctx: BotContext, next: NextFunction) {
    if (!ctx.session.scenarioState.isActive) {
      await this.reply(ctx, "No active scenario. Start one using /scenario first");
      return;
    }
    
    await next();
  }

  // Middleware to check if scenario is NOT active
  private async requireNoScenarioMiddleware(ctx: BotContext, next: NextFunction) {
    if (ctx.session.scenarioState.isActive) {
      await this.reply(ctx, "A scenario is already active. Use /rollback to go back to a previous state if needed.");
      return;
    }
    
    await next();
  }

  private setupMiddleware() {
    // Use session middleware
    this.bot.use(this.sessionMiddleware.bind(this));
    
    // Error handling
    this.bot.catch((err) => {
      logger.error("Bot error", {
        error: err.error,
        stack: err.error instanceof Error ? err.error.stack : undefined,
        ctx: err.ctx.update
      });
    });
  }

  private setupCommands() {
    // Help command
    this.bot.command("help", async (ctx) => {
      const baseCommands = [
        "/role - Create your role",
        "/help - Show this help message"
      ];

      const scenarioCommands = [
        "/scenario - Start a new scenario",
        "/info - Queue an information request",
        "/feed - Queue information to incorporate into the world",
        "/action - Queue an action in the world",
        "/process - Process all queued actions",
        "/remove - Remove an item from the action queue",
        "/rollback - Roll back the scenario to a previous checkpoint"
      ];

      const hasRole = ctx.from && ctx.session.roleAssignments.has(ctx.from.id);
      const availableCommands = [...baseCommands, ...(hasRole ? scenarioCommands : [])];

      await this.reply(ctx, "Available commands:\n" + availableCommands.join("\n"));
    });

    // Role creation command
    this.bot.command("role", async (ctx) => {
      const userId = ctx.from?.id;

      // Get role description from command
      const roleDescription = ctx.match;
      if (!roleDescription) {
        await this.reply(
          ctx,
          "Please provide your role after the /role command. Format: /role <Your Name> - <Your Role>\n" +
          "Example: /role John Smith - Chief Technology Officer at TechCorp"
        );
        return;
      }

      const invalidRoleFormatMessage = "Invalid role format. Please use: /role <Your Name> - <Your Role>\n" +
        "Example: /role John Smith - Chief Technology Officer at TechCorp";
      const indexOfDash = roleDescription.indexOf('-');
      if (indexOfDash === -1) {
        await this.reply(ctx, invalidRoleFormatMessage);
        return;
      }
      
      const parts = [
        roleDescription.substring(0, indexOfDash),
        roleDescription.substring(indexOfDash + 1)
      ].map(part => part.trim());
      
      if (parts.length !== 2) {
        await this.reply(ctx, invalidRoleFormatMessage);
        return;
      }

      const [name, role] = parts;

      // Create new player
      const player: Player = {
        id: userId!,
        name,
        role
      };

      // Assign role to user
      ctx.session.roleAssignments.set(player.id, player);
      await this.reply(ctx, `@${ctx.from?.username} is now ${name} (${role})`);
    });

    // Create a composer for scenario-related commands that require a role
    const scenarioCommands = this.bot.filter(this.requireRoleMiddleware.bind(this));

    // Scenario command - also requires no active scenario
    scenarioCommands.filter(this.requireNoScenarioMiddleware.bind(this)).command("scenario", async (ctx) => {
      const providedScenarioText = ctx.match;
      const scenarioText = providedScenarioText || this.preloadedScenario;
      
      if (!scenarioText) {
        await this.reply(ctx, "Please provide a scenario description after the /scenario command");
        return;
      }

      try {
        await this.reply(ctx, "Starting new scenario…");
        logger.info("Starting new scenario", {
          userId: ctx.from?.id,
          username: ctx.from?.username,
          scenarioText,
          scenarioLength: scenarioText.length
        });

        const players = Array.from(ctx.session.roleAssignments.values());
        const messages = await this.chatService.initializeScenario(scenarioText, players);

        ctx.session.scenarioState.isActive = true;
        ctx.session.scenarioState.messages = messages;

        const hash = this.saveState(ctx);

        await this.sendChunkedReply(ctx, messages[messages.length - 1].content as string);
        await this.reply(ctx, "Initial state saved with hash:");
        await this.reply(ctx, hash);

        logger.info("Scenario started successfully", {
          userId: ctx.from?.id,
          username: ctx.from?.username,
          messageCount: messages.length,
          initialStateHash: hash
        });
      } catch (error) {
        logger.error("Failed to initialize scenario", {
          error,
          userId: ctx.from?.id,
          username: ctx.from?.username,
          scenarioText
        });
        await this.reply(ctx, "Failed to initialize scenario. Please try again later.");
      }
    });

    // Create a composer for commands that require both role and active scenario
    const gameCommands = scenarioCommands.filter(this.requireScenarioMiddleware.bind(this));

    // Info command
    gameCommands.command("info", async (ctx) => {
      const message = ctx.match;
      if (!message) {
        await this.reply(ctx, "Please provide your information request after the /info command");
        return;
      }

      const player = ctx.session.roleAssignments.get(ctx.from?.id!)!;
      ctx.session.actionQueue.push({
        type: UserInteractionType.INFO,
        player,
        content: message
      });

      await this.reply(
        ctx,
        "Information request queued. Use /process to process all pending actions. Use /remove <number> to remove an item from the queue.\n\n" +
        "Current queue:\n" +
        this.formatQueue(ctx.session.actionQueue)
      );
    });

    // Feed command
    gameCommands.command("feed", async (ctx) => {
      const message = ctx.match;
      if (!message) {
        await this.reply(ctx, "Please provide the information after the /feed command");
        return;
      }

      const player = ctx.session.roleAssignments.get(ctx.from?.id!)!;
      ctx.session.actionQueue.push({
        type: UserInteractionType.FEED,
        player,
        content: message
      });

      await this.reply(ctx,
        "Information feed queued. Use /process to process all pending actions.\n\n" +
        "Current queue:\n" +
        this.formatQueue(ctx.session.actionQueue)
      );
    });

    // Action command
    gameCommands.command("action", async (ctx) => {
      const message = ctx.match;
      if (!message) {
        await this.reply(ctx, "Please provide your action after the /action command");
        return;
      }

      const player = ctx.session.roleAssignments.get(ctx.from?.id!)!;
      ctx.session.actionQueue.push({
        type: UserInteractionType.ACTION,
        player,
        content: message
      });

      await this.reply(ctx,
        "Action queued. Use /process to process all pending actions.\n\n" +
        "Current queue:\n" +
        this.formatQueue(ctx.session.actionQueue)
      );
    });

    // Remove command
    gameCommands.command("remove", async (ctx) => {
      const param = ctx.match;
      if (!param) {
        await this.reply(ctx, "Please provide the item number to remove.");
        return;
      }

      const index = parseInt(param, 10);
      if (Number.isNaN(index) || index < 1 || index > ctx.session.actionQueue.length) {
        await this.reply(ctx, "Invalid item number.");
        return;
      }

      ctx.session.actionQueue = ctx.session.actionQueue.filter((_, i) => i !== (index - 1));
      await this.reply(ctx, `Removed item #${index} from the queue.\n\nCurrent queue: \n${this.formatQueue(ctx.session.actionQueue)}`);
    });

    // Process command
    gameCommands.command("process", async (ctx) => {
      if (ctx.session.actionQueue.length === 0) {
        await this.reply(ctx, "No actions to process.");
        return;
      }
      
      await this.reply(ctx, "Processing actions… Please don't add any more actions until the response arrives.");

      try {
        const processActionsResult = await this.chatService.processActions(
          ctx.session.scenarioState.messages,
          ctx.session.actionQueue,
        );

        const lastMessage = processActionsResult[processActionsResult.length - 1];

        const formattedMessages = ctx.session.actionQueue.map(action => {
          switch (action.type) {
            case 'ACTION':
              return `ACTION ${action.player.name}: ${action.content}`;
            default:
              return `${action.type}: ${action.content}`;
          }
        }).join("\n");

        ctx.session.scenarioState.messages.push({
          role: "user",
          content: formattedMessages
        });
        
        ctx.session.scenarioState.messages.push(lastMessage);

        const hash = this.saveState(ctx);

        logger.info("Canonical scenario messages", ctx.session.scenarioState.messages);

        await this.sendChunkedReply(ctx, lastMessage.content as string);
        await this.reply(ctx, `State saved with hash:`);
        await this.reply(ctx, hash);

        // Clear the queue after successful processing
        ctx.session.actionQueue = [];

      } catch (error) {
        logger.error("Failed to process actions", { error });
        await this.reply(ctx, "Failed to process actions. Please try again later.");
      }
    });

    // Rollback command
    gameCommands.command("rollback", async (ctx) => {
      const hash = ctx.match;
      if (!hash) {
        await this.reply(ctx, "Please provide a state hash after the /rollback command");
        return;
      }

      const state = ctx.session.scenarioCheckpoints.get(hash);
      if (!state) {
        await this.reply(ctx, "Invalid state hash. Please provide a valid hash from a previous state.");
        return;
      }

      // Restore the state
      ctx.session.scenarioState = JSON.parse(JSON.stringify(state));

      await this.reply(ctx, `Successfully rolled back to state ${hash}`);
      await this.sendChunkedReply(ctx, "Current state:\n" + state.messages[state.messages.length - 1].content);
    });
  }

  // Method to handle incoming webhook updates
  public handleUpdate(update: any) {
    return webhookCallback(this.bot, 'cloudflare-workers')(update);
  }

  // Method to set webhook with Telegram
  public async setWebhook(url: string) {
    return this.bot.api.setWebhook(url);
  }

  // Method to delete webhook with Telegram
  public async deleteWebhook() {
    return this.bot.api.deleteWebhook();
  }
}