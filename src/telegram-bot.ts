import { Bot, Context, NextFunction, webhookCallback } from "grammy";
import { SessionData, CloudflareKVStorage, getInitialSessionData } from "./storage";
import { ChatService, DefaultAnthropicClient, ChatCompletionMessageParam } from "./anthropic";
import logger from "./logger";
import { Player, UserInteraction, UserInteractionType } from "./types";

type BotContext = Context & {
  session: SessionData;
};

// Helper function to generate hash for scenario state using Web Crypto API
const generateStateHash = async (state: any): Promise<string> => {
  const stateString = JSON.stringify(state);
  const encoder = new TextEncoder();
  const data = encoder.encode(stateString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.slice(0, 8);
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
    // Validate inputs
    if (!telegramToken) {
      throw new Error("Telegram token is required");
    }
    
    if (!anthropicApiKey) {
      throw new Error("Anthropic API key is required");
    }
    
    if (!kvNamespace) {
      throw new Error("KV namespace is required");
    }
    
    // Initialize bot and services
    console.log("Initializing TelegramBot...");
    this.bot = new Bot<BotContext>(telegramToken);
    const anthropicClient = new DefaultAnthropicClient(anthropicApiKey);
    this.chatService = new ChatService(anthropicClient);
    this.storage = new CloudflareKVStorage(kvNamespace);
    this.preloadedScenario = preloadedScenario;
    
    console.log("Setting up middleware and commands...");
    this.setupMiddleware();
    this.setupCommands();
    console.log("TelegramBot initialization complete");
  }

  private async reply(ctx: BotContext, message: string) {
    try {
      return await ctx.reply(message);
    } catch (error) {
      logger.error('Failed to send reply', { error, chatId: ctx.chat?.id });
      // Try to send a simplified message if the original fails
      try {
        return await ctx.reply('Error sending message. Please try again.');
      } catch (fallbackError) {
        logger.error('Failed to send fallback reply', { error: fallbackError, chatId: ctx.chat?.id });
      }
    }
  }

  // Helper function to send chunked replies
  private async sendChunkedReply(ctx: BotContext, content: string) {
    const chunks = chunkText(content, 4096);
    for (const chunk of chunks) {
      try {
        await this.reply(ctx, chunk);
      } catch (error) {
        logger.error('Failed to send chunked reply', { error, chatId: ctx.chat?.id });
        break; // Stop sending chunks if one fails
      }
    }
  }

  // Helper function to save current state
  private async saveState(ctx: BotContext): Promise<string> {
    try {
      const hash = await generateStateHash(ctx.session.scenarioState);
      ctx.session.scenarioCheckpoints.set(hash, JSON.parse(JSON.stringify(ctx.session.scenarioState)));
      return hash;
    } catch (error) {
      logger.error('Failed to save state', { error });
      throw new Error('Failed to save state: ' + (error instanceof Error ? error.message : String(error)));
    }
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
    // Make sure context has a session object to prevent "undefined" errors
    if (!ctx.session) {
      ctx.session = getInitialSessionData();
    }
    
    // Create a unique key for the chat session
    const chatId = ctx.chat?.id;
    if (!chatId) {
      logger.error('No chat ID found in context', { ctx: JSON.stringify(ctx).substring(0, 200) });
      console.error("No chat ID found in context");
      return; // Can't proceed without chat ID
    }
    
    const sessionKey = `chat_${chatId}`;
    console.log(`Loading session for key: ${sessionKey}`);
    
    try {
      // Retrieve session from KV or create initial session
      let session;
      try {
        session = await this.storage.get(sessionKey);
        if (session) {
          console.log(`Found existing session for ${sessionKey}`);
          logger.debug('Retrieved existing session', { 
            sessionKey, 
            roleCount: session.roleAssignments?.size || 0,
            isScenarioActive: session.scenarioState?.isActive || false,
            queueLength: session.actionQueue?.length || 0
          });
          
          // Validate session structure and repair if needed
          if (!session.roleAssignments) {
            logger.warn('Repairing missing roleAssignments in session', { sessionKey });
            session.roleAssignments = new Map();
          }
          
          if (!session.scenarioState) {
            logger.warn('Repairing missing scenarioState in session', { sessionKey });
            session.scenarioState = { isActive: false, messages: [] };
          }
          
          if (!session.scenarioCheckpoints) {
            logger.warn('Repairing missing scenarioCheckpoints in session', { sessionKey });
            session.scenarioCheckpoints = new Map();
          }
          
          if (!session.actionQueue) {
            logger.warn('Repairing missing actionQueue in session', { sessionKey });
            session.actionQueue = [];
          }
        }
      } catch (kvError) {
        console.error(`Error retrieving session from KV: ${kvError}`);
        logger.error('Error retrieving session from KV', { 
          error: kvError, 
          errorMessage: kvError instanceof Error ? kvError.message : String(kvError),
          sessionKey 
        });
      }
      
      if (!session) {
        console.log(`Creating new session for ${sessionKey}`);
        session = getInitialSessionData();
        logger.debug('Created new session', { sessionKey });
      }
      
      // Attach session to context
      ctx.session = session;
      
      try {
        // Let other middleware and handlers process the update
        await next();
        
        // Log before saving
        console.log(`Saving session for ${sessionKey}`);
        logger.debug('About to save session', {
          sessionKey,
          roleCount: ctx.session.roleAssignments?.size || 0,
          isScenarioActive: ctx.session.scenarioState?.isActive || false,
          queueLength: ctx.session.actionQueue?.length || 0
        });
        
        // Save the possibly modified session back to KV
        await this.storage.set(sessionKey, ctx.session);
        console.log(`Session saved successfully for ${sessionKey}`);
      } catch (nextError) {
        console.error(`Error in next middleware/handler: ${nextError}`);
        logger.error('Error in next middleware/handler', { 
          error: nextError, 
          errorMessage: nextError instanceof Error ? nextError.message : String(nextError),
          stack: nextError instanceof Error ? nextError.stack : undefined,
          sessionKey 
        });
        
        // Still try to save the session even if there was an error in the handlers
        try {
          await this.storage.set(sessionKey, ctx.session);
          logger.debug('Session saved despite handler error', { sessionKey });
        } catch (saveError) {
          logger.error('Failed to save session after handler error', { 
            error: saveError,
            errorMessage: saveError instanceof Error ? saveError.message : String(saveError),
            sessionKey 
          });
        }
        
        throw nextError; // Re-throw to propagate the error
      }
    } catch (error) {
      console.error(`Critical session middleware error: ${error}`);
      logger.error('Critical session middleware error', { 
        error, 
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        sessionKey 
      });
      
      // Try to notify the user
      try {
        await this.reply(ctx, "An error occurred processing your request. Please try again.");
      } catch (replyError) {
        logger.error('Failed to send error notification', { error: replyError });
      }
    }
  }

  // Middleware to check if user has a role
  private async requireRoleMiddleware(ctx: BotContext, next: NextFunction): Promise<boolean> {
    try {
      const userId = ctx.from?.id;
      console.log(`Checking if user ${userId} has a role`);
      
      if (!userId) {
        console.log("No user ID found in context");
        await this.reply(ctx, "User ID not found. Please try again.");
        return false;
      }
      
      if (!ctx.session) {
        console.error("No session found in context");
        await this.reply(ctx, "Session not found. Please try again.");
        return false;
      }
      
      if (!ctx.session.roleAssignments) {
        console.error("No roleAssignments in session");
        ctx.session.roleAssignments = new Map(); // Repair the session
        await this.reply(ctx, "Role assignments not found. Please select a role using /role");
        return false;
      }
      
      if (!ctx.session.roleAssignments.has(userId)) {
        console.log(`User ${userId} doesn't have a role yet`);
        await this.reply(ctx, "You need to select a role first using /role");
        return false;
      }
      
      console.log(`User ${userId} has role: ${ctx.session.roleAssignments.get(userId)?.role}`);
      await next();
      return true;
    } catch (error) {
      console.error("Error in requireRoleMiddleware:", error);
      logger.error("Error in requireRoleMiddleware", { 
        error, 
        errorMessage: error instanceof Error ? error.message : String(error),
        userId: ctx.from?.id 
      });
      await this.reply(ctx, "Error checking role. Please try again.");
      return false;
    }
  }

  // Middleware to check if scenario is active
  private async requireScenarioMiddleware(ctx: BotContext, next: NextFunction): Promise<boolean> {
    try {
      console.log("Checking if scenario is active");
      
      if (!ctx.session) {
        console.error("No session found in context");
        await this.reply(ctx, "Session not found. Please try again.");
        return false;
      }
      
      if (!ctx.session.scenarioState) {
        console.error("No scenarioState in session");
        ctx.session.scenarioState = { isActive: false, messages: [] }; // Repair the session
        await this.reply(ctx, "Scenario state not found. Please start a new scenario using /scenario");
        return false;
      }
      
      if (!ctx.session.scenarioState.isActive) {
        console.log("No active scenario");
        await this.reply(ctx, "No active scenario. Start one using /scenario first");
        return false;
      }
      
      console.log("Scenario is active");
      await next();
      return true;
    } catch (error) {
      console.error("Error in requireScenarioMiddleware:", error);
      logger.error("Error in requireScenarioMiddleware", { 
        error,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      await this.reply(ctx, "Error checking scenario. Please try again.");
      return false;
    }
  }

  // Middleware to check if scenario is NOT active
  private async requireNoScenarioMiddleware(ctx: BotContext, next: NextFunction): Promise<boolean> {
    try {
      console.log("Checking if no scenario is active");
      
      if (!ctx.session) {
        console.error("No session found in context");
        await this.reply(ctx, "Session not found. Please try again.");
        return false;
      }
      
      if (!ctx.session.scenarioState) {
        console.error("No scenarioState in session");
        // If no scenario state, we can consider no scenario active
        ctx.session.scenarioState = { isActive: false, messages: [] }; // Repair the session
        await next();
        return true;
      }
      
      if (ctx.session.scenarioState.isActive) {
        console.log("Scenario is already active");
        await this.reply(ctx, "A scenario is already active. Use /rollback to go back to a previous state if needed.");
        return false;
      }
      
      console.log("No active scenario, proceeding");
      await next();
      return true;
    } catch (error) {
      console.error("Error in requireNoScenarioMiddleware:", error);
      logger.error("Error in requireNoScenarioMiddleware", { 
        error,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      await this.reply(ctx, "Error checking scenario state. Please try again.");
      return false;
    }
  }

  private setupMiddleware() {
    // Use session middleware
    this.bot.use(this.sessionMiddleware.bind(this));
    
    // Error handling
    this.bot.catch((err) => {
      logger.error("Bot error", {
        error: err.error,
        errorMessage: err.error instanceof Error ? err.error.message : String(err.error),
        stack: err.error instanceof Error ? err.error.stack : undefined,
        ctx: err.ctx.update
      });
      
      // Try to notify the user about the error
      try {
        err.ctx.reply("Sorry, an error occurred processing your request. Please try again.");
      } catch (replyError) {
        logger.error("Failed to send error notification", { error: replyError });
      }
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

      const hasRole = ctx.from && ctx.session.roleAssignments && ctx.session.roleAssignments.has(ctx.from.id);
      const availableCommands = [...baseCommands, ...(hasRole ? scenarioCommands : [])];

      await this.reply(ctx, "Available commands:\n" + availableCommands.join("\n"));
    });

    // Role creation command
    this.bot.command("role", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) {
        await this.reply(ctx, "Could not identify user. Please try again.");
        return;
      }

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

        const hash = await this.saveState(ctx);

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

        const hash = await this.saveState(ctx);

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

  // Helper function to list available scenario options
  private async listScenarioOptions(ctx: BotContext): Promise<void> {
    const chatType = ctx.chat?.type || "private";
    const chatId = ctx.chat?.id;
    
    // Log chat information
    console.log(`Listing scenarios for ${chatType} chat with ID ${chatId}`);
    
    const chatLabel = chatType === "private" ? "personal chat" : 
                     chatType === "group" ? "this group" : 
                     chatType === "supergroup" ? "this supergroup" : "this chat";
    
    const availableScenarios = [
      {
        name: "Ukraine-Russia Conflict (October 2025)",
        id: "zelensky",
        description: "A scenario set in October 2025 exploring ongoing developments in the Russia-Ukraine conflict during Trump's presidency."
      },
      {
        name: "AI & Biology (2027)",
        id: "nvidia",
        description: "A scenario exploring the intersection of AI and biology in 2027, after significant advancements in models accessible to the public."
      },
      {
        name: "Custom Scenario",
        id: "custom",
        description: "Provide your own custom scenario."
      }
    ];
    
    let messageText = `Please select a scenario to begin in ${chatLabel}:\n\n`;
    
    // Add standard scenarios
    availableScenarios.forEach((scenario, index) => {
      messageText += `${index + 1}. ${scenario.name}\n${scenario.description}\n\n`;
    });
    
    // Helper to determine scenario type from messages
    const getScenarioType = (messages: Array<any>): string => {
      // Look at first system or user message to determine scenario type
      for (const msg of messages) {
        const content = msg.content as string;
        if (content) {
          if (content.includes("Russia-Ukraine") || content.includes("Zelenskyy") || content.includes("Trump")) {
            return "Ukraine-Russia Conflict";
          } else if (content.includes("AI") || content.includes("biological") || content.includes("NVIDIA")) {
            return "AI & Biology";
          }
        }
      }
      return "Custom Scenario";
    };
    
    // Check for any saved final states
    const finalStates: Array<{hash: string, scenarioType: string}> = [];
    let finalStateIndex = availableScenarios.length + 1;
    
    // Look for keys that start with "final_" to find saved final states
    if (ctx.session?.scenarioCheckpoints) {
      for (const [key, state] of ctx.session.scenarioCheckpoints.entries()) {
        if (typeof key === 'string' && key.startsWith('final_')) {
          const hash = key.substring(6); // Remove 'final_' prefix
          const scenarioType = getScenarioType(state.messages);
          finalStates.push({ hash, scenarioType });
        }
      }
    }
    
    // Add saved scenarios if any exist
    if (finalStates.length > 0) {
      messageText += `📋 Saved Scenarios for ${chatLabel}:\n`;
      
      finalStates.forEach(({ hash, scenarioType }, index) => {
        messageText += `${finalStateIndex + index}. [${scenarioType}] ${hash}\n`;
      });
      
      messageText += "\nTo load a saved scenario, use:\n/rollback " + finalStates[0].hash + "\n\n";
      messageText += "Or to see all available states:\n/rollback\n\n";
    }
    
    messageText += "To select a scenario, use:\n/scenario 1 (or 2, 3, etc.)\n\nOr provide your own custom scenario with:\n/scenario Your detailed scenario description...";
    
    await ctx.reply(messageText);
  }
  
  // Helper method to handle rollback command - works regardless of active scenario state
  private async handleRollbackCommand(ctx: BotContext, args: string, session: SessionData): Promise<void> {
    try {
      const chatType = ctx.chat?.type || "private";
      const chatId = ctx.chat?.id;
      
      // Log chat information
      console.log(`Processing rollback for ${chatType} chat with ID ${chatId}`);
      
      const chatLabel = chatType === "private" ? "personal chat" : 
                        chatType === "group" ? "this group" : 
                        chatType === "supergroup" ? "this supergroup" : "this chat";
      
      // Get all checkpoints and categorize them
      const regularCheckpoints: Array<{hash: string, state: ScenarioState}> = [];
      const finalStates: Array<{hash: string, state: ScenarioState, scenarioType?: string}> = [];
      
      // Helper to determine scenario type from messages
      const getScenarioType = (messages: Array<any>): string => {
        // Look at first system or user message to determine scenario type
        for (const msg of messages) {
          const content = msg.content as string;
          if (content) {
            if (content.includes("Russia-Ukraine") || content.includes("Zelenskyy") || content.includes("Trump")) {
              return "Ukraine-Russia Conflict";
            } else if (content.includes("AI") || content.includes("biological") || content.includes("NVIDIA")) {
              return "AI & Biology";
            }
          }
        }
        return "Custom Scenario";
      };
      
      // Iterate through all checkpoints to categorize them
      for (const [key, state] of session.scenarioCheckpoints.entries()) {
        if (typeof key === 'string') {
          if (key.startsWith('final_')) {
            const hash = key.substring(6); // Remove 'final_' prefix
            const scenarioType = getScenarioType(state.messages);
            finalStates.push({ hash, state, scenarioType });
          } else {
            regularCheckpoints.push({ hash: key, state });
          }
        }
      }
      
      // If user didn't provide args, list available checkpoints
      if (!args) {
        let message = "";
        
        // Show final (saved) states first - these are the most important
        if (finalStates.length > 0) {
          message += `📋 Saved Scenarios for ${chatLabel}:\n`;
          finalStates.forEach(({ hash, scenarioType }, index) => {
            message += `${index + 1}. [${scenarioType || 'Unknown'}] ${hash}\n`;
          });
          message += "\n";
        }
        
        // Show regular checkpoints next
        if (regularCheckpoints.length > 0) {
          message += `📝 In-Progress Checkpoints for ${chatLabel}:\n`;
          regularCheckpoints.forEach(({ hash }, index) => {
            message += `${index + 1}. ${hash}\n`;
          });
          message += "\n";
        }
        
        // If we have any checkpoints, provide instructions
        if (finalStates.length > 0 || regularCheckpoints.length > 0) {
          message += "To restore a state, use:\n/rollback [hash]";
          await ctx.reply(message);
        } else {
          await ctx.reply(`No saved states available for ${chatLabel}. Start a scenario with /scenario first.`);
        }
        return;
      }
      
      // If user provided args, try to restore the checkpoint
      const hash = args;
      
      // First check if this is a saved final state with the "final_" prefix
      let state = session.scenarioCheckpoints.get(`final_${hash}`);
      
      // If not found with prefix, try the direct hash
      if (!state) {
        state = session.scenarioCheckpoints.get(hash);
      }
      
      if (!state) {
        await ctx.reply(`Invalid state hash. Please provide a valid hash from a previous state in ${chatLabel}.`);
        
        // If they provided an invalid hash but we have states, list them
        if (finalStates.length > 0 || regularCheckpoints.length > 0) {
          let validHashes = `Valid hashes for ${chatLabel}:\n`;
          
          finalStates.forEach(({ hash, scenarioType }) => {
            validHashes += `- ${hash} (${scenarioType || 'Saved'})\n`;
          });
          
          regularCheckpoints.forEach(({ hash }) => {
            validHashes += `- ${hash}\n`;
          });
          
          await ctx.reply(validHashes);
        }
      } else {
        // Restore the state
        session.scenarioState = JSON.parse(JSON.stringify(state));
        
        // If this was a final state (inactive scenario), make sure it's active now
        session.scenarioState.isActive = true;
        
        // Determine scenario type
        const scenarioType = getScenarioType(state.messages);
        
        await ctx.reply(`Successfully restored scenario in ${chatLabel}: ${scenarioType || 'Unknown'} (${hash})`);
        
        const responseText = state.messages[state.messages.length - 1].content as string;
        const chunks = chunkText("Current state:\n" + responseText, 4096);
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
        
        // Remind about available commands
        await ctx.reply("You can now use:\n/info - Request information\n/feed - Add information to the world\n/action - Perform an action\n/process - Process all queued actions");
      }
    } catch (error) {
      console.error("Error in handleRollbackCommand:", error);
      logger.error("Error handling rollback", { error });
      await ctx.reply("An error occurred while processing the rollback command. Please try again.");
    }
  }

  // Helper function to get scenario content from file
  private async getScenarioContent(scenarioId: string): Promise<string | undefined> {
    // In a real implementation, this would read from the filesystem
    // For Cloudflare Workers, you might store these in KV instead
    switch (scenarioId) {
      case "zelensky":
        return `Here's a concise synopsis and background on the Russia-Ukraine war, with a focus on Ukrainian President Volodymyr Zelenskyy's presidency and key questions surrounding his future.

The Russia-Ukraine war escalated into a full-scale conflict on February 24, 2022, when Russia, under President Vladimir Putin, launched a large-scale invasion of Ukraine. By early 2025, the conflict remains unresolved, with Russia occupying roughly 20% of Ukrainian territory.

As of October 2025, there have not been many significant developments despite Trump's multiple meetings with Zelenskyy and Putin. Various ceasefires have been attempted, but none have lasted.`;
      
      case "nvidia":
        return `In 2027, two years after NVIDIA's introduction of powerful AI chips for desktop use and their partnership with Arc Institute on biological AI models, a significant threshold has been crossed in biological AI accessibility.

Amateur biohackers now have access to AI models capable of designing custom proteins and genetic sequences using only consumer-grade hardware. These models, while originally developed for medical research, have been adapted by the open-source community into tools that can be run on home computers.

The combination of widely available compute power and increasingly sophisticated biological AI models has created a situation where individuals with basic biology knowledge can design molecules with potentially significant biological activity.`;
        
      default:
        return undefined;
    }
  }

  // Method to handle incoming webhook updates - completely rewritten for simplicity and reliability
  public async handleUpdate(update: any) {
    try {
      // Log extensively for debugging
      console.log("====== START WEBHOOK HANDLER ======");
      console.log("Received webhook update:", JSON.stringify(update, null, 2).substring(0, 1000));
      
      logger.info("Received webhook update", { 
        updateType: update?.message?.text ? "message" : "other",
        updateId: update?.update_id,
        chatId: update?.message?.chat?.id,
        fromId: update?.message?.from?.id,
        text: update?.message?.text?.substring(0, 100)
      });
      
      // SIMPLIFIED APPROACH: Only handle commands directly without using Grammy middleware
      if (update?.message?.text && update.message.text.startsWith('/')) {
        const chatId = update.message.chat.id;
        const text = update.message.text;
        const userId = update.message.from?.id;
        
        // Parse command and arguments
        const commandMatch = text.match(/^\/([a-zA-Z0-9_]+)(@\w+)?(\s+(.*))?$/);
        if (!commandMatch) {
          return new Response("OK", { status: 200 }); // Not a valid command format
        }
        
        const command = commandMatch[1]; // The command name
        const args = commandMatch[4] || ""; // Everything after the command
        
        console.log(`Processing command: /${command} with args: ${args}`);
        
        // Get or create session directly
        const sessionKey = `chat_${chatId}`;
        console.log(`Loading session for key: ${sessionKey}`);
        
        let session: SessionData = getInitialSessionData();
        try {
          const storedSession = await this.storage.get(sessionKey);
          if (storedSession) {
            console.log(`Found existing session for ${sessionKey}`);
            session = storedSession;
            
            // Ensure all session properties exist
            if (!session.roleAssignments) session.roleAssignments = new Map();
            if (!session.scenarioState) session.scenarioState = { isActive: false, messages: [] };
            if (!session.scenarioCheckpoints) session.scenarioCheckpoints = new Map();
            if (!session.actionQueue) session.actionQueue = [];
          }
        } catch (error) {
          console.error(`Error retrieving session: ${error}`);
          logger.error("Error retrieving session", { error, sessionKey });
          // Continue with empty session
        }
        
        // Simplified context for command handling
        const ctx = {
          chat: update.message.chat,
          from: update.message.from,
          message: update.message,
          match: args,
          session: session,
          reply: async (replyText: string) => {
            try {
              return await this.bot.api.sendMessage(chatId, replyText);
            } catch (replyError) {
              console.error(`Error sending reply: ${replyError}`);
              logger.error("Error sending reply", { error: replyError, chatId });
              return null;
            }
          }
        } as BotContext;
        
        // Handle commands without middleware - direct handling
        try {
          let handled = false;
          
          // Handle /help command
          if (command === "help") {
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
              "/rollback - Roll back the scenario to a previous checkpoint",
              "/end - End the current scenario and save its final state"
            ];
            
            const hasRole = userId && session.roleAssignments.has(userId);
            const availableCommands = [...baseCommands, ...(hasRole ? scenarioCommands : [])];
            
            await ctx.reply("Available commands:\n" + availableCommands.join("\n"));
            handled = true;
          }
          
          // Handle /role command
          else if (command === "role") {
            if (!userId) {
              await ctx.reply("Could not identify user. Please try again.");
            } else if (!args) {
              await ctx.reply(
                "Please provide your role after the /role command. Format: /role <Your Name> - <Your Role>\n" +
                "Example: /role John Smith - Chief Technology Officer at TechCorp"
              );
            } else {
              const invalidRoleFormatMessage = "Invalid role format. Please use: /role <Your Name> - <Your Role>\n" +
                "Example: /role John Smith - Chief Technology Officer at TechCorp";
              
              const indexOfDash = args.indexOf('-');
              if (indexOfDash === -1) {
                await ctx.reply(invalidRoleFormatMessage);
              } else {
                const parts = [
                  args.substring(0, indexOfDash),
                  args.substring(indexOfDash + 1)
                ].map(part => part.trim());
                
                if (parts.length !== 2) {
                  await ctx.reply(invalidRoleFormatMessage);
                } else {
                  const [name, role] = parts;
                  
                  // Create new player
                  const player: Player = {
                    id: userId,
                    name,
                    role
                  };
                  
                  // Assign role to user
                  session.roleAssignments.set(player.id, player);
                  await ctx.reply(`@${ctx.from?.username} is now ${name} (${role})`);
                  
                  // After role is assigned, prompt for scenario
                  await ctx.reply("Now you can start a scenario with the /scenario command.");
                  await this.listScenarioOptions(ctx);
                }
              }
            }
            handled = true;
          }
          
          // For other commands, check if user has role first
          else if (userId && session.roleAssignments.has(userId)) {
            const player = session.roleAssignments.get(userId)!;
            
            // Special handling for rollback command - works regardless of active scenario state
            if (command === "rollback") {
              await this.handleRollbackCommand(ctx, args, session);
              handled = true;
            }
            // Handle scenario command - requires no active scenario
            else if (command === "scenario" && !session.scenarioState.isActive) {
              // If no args provided, show available scenarios
              if (!args) {
                await this.listScenarioOptions(ctx);
                handled = true;
                
              } else {
                let scenarioText = "";
                
                // Check if they're selecting a scenario by number
                const scenarioMatch = args.match(/^[1-3]$/);
                if (scenarioMatch) {
                  const selection = parseInt(scenarioMatch[0], 10);
                  switch (selection) {
                    case 1: // Ukraine-Russia
                      scenarioText = await this.getScenarioContent("zelensky") || "";
                      break;
                    case 2: // AI & Biology
                      scenarioText = await this.getScenarioContent("nvidia") || "";
                      break;
                    case 3: // Custom scenario - prompt for text
                      await ctx.reply("Please enter your custom scenario description with:\n/scenario Your detailed scenario description...");
                      handled = true;
                      break;
                  }
                } else {
                  // They've provided their own scenario text
                  scenarioText = args || this.preloadedScenario || "";
                }
                
                // Skip processing if it was just a request for selection 3 (custom)
                if (scenarioText) {
                  try {
                    await ctx.reply("Starting new scenario…");
                    logger.info("Starting new scenario", {
                      userId: userId,
                      username: ctx.from?.username,
                      scenarioLength: scenarioText.length
                    });
                    
                    const players = Array.from(session.roleAssignments.values());
                    const messages = await this.chatService.initializeScenario(scenarioText, players);
                    
                    session.scenarioState.isActive = true;
                    session.scenarioState.messages = messages;
                    
                    // Save state
                    const hash = await generateStateHash(session.scenarioState);
                    session.scenarioCheckpoints.set(hash, JSON.parse(JSON.stringify(session.scenarioState)));
                    
                    const lastMessage = messages[messages.length - 1].content as string;
                    const chunks = chunkText(lastMessage, 4096);
                    for (const chunk of chunks) {
                      await ctx.reply(chunk);
                    }
                    
                    // Show available actions after scenario starts
                    await ctx.reply("Initial state saved with hash:");
                    await ctx.reply(hash);
                    
                    // Provide guidance on next steps
                    await ctx.reply("Scenario started! You can now use:\n/info - Request information\n/feed - Add information to the world\n/action - Perform an action\n/process - Process all queued actions");
                    
                    logger.info("Scenario started successfully", {
                      userId: userId,
                      username: ctx.from?.username,
                      messageCount: messages.length,
                      initialStateHash: hash
                    });
                  } catch (error) {
                    logger.error("Failed to initialize scenario", {
                      error,
                      userId: userId,
                      username: ctx.from?.username
                    });
                    await ctx.reply("Failed to initialize scenario. Please try again later.");
                  }
                }
                handled = true;
              }
            }
            
            // Commands that require an active scenario
            else if (session.scenarioState.isActive) {
              // Handle /info command
              if (command === "info") {
                if (!args) {
                  await ctx.reply("Please provide your information request after the /info command");
                } else {
                  session.actionQueue.push({
                    type: UserInteractionType.INFO,
                    player,
                    content: args
                  });
                  
                  await ctx.reply(
                    "Information request queued. Use /process to process all pending actions. Use /remove <number> to remove an item from the queue.\n\n" +
                    "Current queue:\n" +
                    this.formatQueue(session.actionQueue)
                  );
                }
                handled = true;
              }
              
              // Handle /feed command
              else if (command === "feed") {
                if (!args) {
                  await ctx.reply("Please provide the information after the /feed command");
                } else {
                  session.actionQueue.push({
                    type: UserInteractionType.FEED,
                    player,
                    content: args
                  });
                  
                  await ctx.reply(
                    "Information feed queued. Use /process to process all pending actions.\n\n" +
                    "Current queue:\n" +
                    this.formatQueue(session.actionQueue)
                  );
                }
                handled = true;
              }
              
              // Handle /action command
              else if (command === "action") {
                if (!args) {
                  await ctx.reply("Please provide your action after the /action command");
                } else {
                  session.actionQueue.push({
                    type: UserInteractionType.ACTION,
                    player,
                    content: args
                  });
                  
                  await ctx.reply(
                    "Action queued. Use /process to process all pending actions.\n\n" +
                    "Current queue:\n" +
                    this.formatQueue(session.actionQueue)
                  );
                }
                handled = true;
              }
              
              // Handle /remove command
              else if (command === "remove") {
                if (!args) {
                  await ctx.reply("Please provide the item number to remove.");
                } else {
                  const index = parseInt(args, 10);
                  if (Number.isNaN(index) || index < 1 || index > session.actionQueue.length) {
                    await ctx.reply("Invalid item number.");
                  } else {
                    session.actionQueue = session.actionQueue.filter((_, i) => i !== (index - 1));
                    await ctx.reply(`Removed item #${index} from the queue.\n\nCurrent queue: \n${this.formatQueue(session.actionQueue)}`);
                  }
                }
                handled = true;
              }
              
              // Handle /process command
              else if (command === "process") {
                if (session.actionQueue.length === 0) {
                  await ctx.reply("No actions to process.");
                } else {
                  await ctx.reply("Processing actions… Please don't add any more actions until the response arrives.");
                  
                  try {
                    const processActionsResult = await this.chatService.processActions(
                      session.scenarioState.messages,
                      session.actionQueue,
                    );
                    
                    const lastMessage = processActionsResult[processActionsResult.length - 1];
                    
                    const formattedMessages = session.actionQueue.map(action => {
                      switch (action.type) {
                        case 'ACTION':
                          return `ACTION ${action.player.name}: ${action.content}`;
                        default:
                          return `${action.type}: ${action.content}`;
                      }
                    }).join("\n");
                    
                    session.scenarioState.messages.push({
                      role: "user",
                      content: formattedMessages
                    });
                    
                    session.scenarioState.messages.push(lastMessage);
                    
                    // Save state
                    const hash = await generateStateHash(session.scenarioState);
                    session.scenarioCheckpoints.set(hash, JSON.parse(JSON.stringify(session.scenarioState)));
                    
                    logger.info("Canonical scenario messages", session.scenarioState.messages);
                    
                    const responseText = lastMessage.content as string;
                    const chunks = chunkText(responseText, 4096);
                    for (const chunk of chunks) {
                      await ctx.reply(chunk);
                    }
                    
                    await ctx.reply(`State saved with hash:`);
                    await ctx.reply(hash);
                    
                    // Clear the queue after successful processing
                    session.actionQueue = [];
                  } catch (error) {
                    logger.error("Failed to process actions", { error });
                    await ctx.reply("Failed to process actions. Please try again later.");
                  }
                }
                handled = true;
              }
              
              // Rollback handler moved to separate method
              
              // Handle /end command - End the current scenario but save its state
              else if (command === "end") {
                // Save the final state with a special tag
                try {
                  const chatType = ctx.chat?.type || "private";
                  const chatId = ctx.chat?.id;
                  
                  const chatLabel = chatType === "private" ? "personal chat" : 
                                   chatType === "group" ? "this group" : 
                                   chatType === "supergroup" ? "this supergroup" : "this chat";
                  
                  // Generate a hash for the final state
                  const finalHash = await generateStateHash(session.scenarioState);
                  
                  // Store the checkpoint with a special "final state" marker
                  const finalState = JSON.parse(JSON.stringify(session.scenarioState));
                  session.scenarioCheckpoints.set(finalHash, finalState);
                  
                  // Also store in a special slot that makes it easier to identify as the final state
                  const finalStateMarker = "final_" + finalHash;
                  session.scenarioCheckpoints.set(finalStateMarker, finalState);
                  
                  // End the scenario
                  session.scenarioState.isActive = false;
                  
                  // Clear the action queue
                  session.actionQueue = [];
                  
                  // Helper to determine scenario type from messages
                  const getScenarioType = (messages: Array<any>): string => {
                    for (const msg of messages) {
                      const content = msg.content as string;
                      if (content) {
                        if (content.includes("Russia-Ukraine") || content.includes("Zelenskyy") || content.includes("Trump")) {
                          return "Ukraine-Russia Conflict";
                        } else if (content.includes("AI") || content.includes("biological") || content.includes("NVIDIA")) {
                          return "AI & Biology";
                        }
                      }
                    }
                    return "Custom Scenario";
                  };
                  
                  const scenarioType = getScenarioType(session.scenarioState.messages);
                  
                  await ctx.reply(`[${scenarioType}] scenario in ${chatLabel} ended and saved with hash: ${finalHash}`);
                  await ctx.reply(`You can return to this exact state at any time with:\n/rollback ${finalHash}`);
                  
                  // Offer to start a new scenario
                  await ctx.reply(`You can start a new scenario in ${chatLabel} with the /scenario command`);
                  
                  logger.info("Scenario ended", {
                    userId,
                    chatId,
                    chatType,
                    scenarioType,
                    finalStateHash: finalHash
                  });
                } catch (error) {
                  logger.error("Error ending scenario", { error });
                  await ctx.reply("Error saving final state. Please try again.");
                }
                handled = true;
              }
            }
            
            // If command wasn't handled but user has role, provide guidance
            if (!handled) {
              if (command === "scenario" && session.scenarioState.isActive) {
                await ctx.reply("A scenario is already active. Use /rollback to go back to a previous state if needed.");
              } else if (["info", "feed", "action", "process", "remove", "rollback"].includes(command) && !session.scenarioState.isActive) {
                await ctx.reply("No active scenario. Start one using /scenario first.");
              } else {
                await ctx.reply(`Unknown command: /${command}. Use /help to see available commands.`);
              }
              handled = true;
            }
          }
          
          // If command wasn't handled and user doesn't have role, guide them to /role
          if (!handled && command !== "help") {
            await ctx.reply("You need to select a role first using /role");
          }
          
          // Always save the session after command handling
          try {
            await this.storage.set(sessionKey, session);
            console.log(`Session saved successfully for ${sessionKey}`);
          } catch (saveError) {
            console.error(`Error saving session: ${saveError}`);
            logger.error("Error saving session", { error: saveError, sessionKey });
          }
          
        } catch (commandError) {
          console.error(`Error handling command: ${commandError}`);
          logger.error("Error handling command", { 
            error: commandError, 
            command, 
            args,
            chatId,
            userId
          });
          
          try {
            await this.bot.api.sendMessage(chatId, "An error occurred processing your request. Please try again.");
          } catch (replyError) {
            logger.error("Failed to send error notification", { error: replyError });
          }
        }
      }
      
      console.log("====== END WEBHOOK HANDLER ======");
      logger.info("Webhook handler completed");
      
      // Always return OK to Telegram to avoid repeated delivery
      return new Response("OK", { status: 200 });
    } catch (error) {
      // Catch any uncaught exceptions
      console.error("CRITICAL ERROR in handleUpdate:", error);
      
      logger.error("Critical error in webhook handler", { 
        error, 
        errorName: error?.name,
        errorMessage: error?.message,
        stack: error?.stack,
        updateData: JSON.stringify(update || {}).substring(0, 200)
      });
      
      // Always return success to Telegram to avoid repeated delivery
      // Even if handling failed, we don't want Telegram to retry
      return new Response("OK", { status: 200 });
    }
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