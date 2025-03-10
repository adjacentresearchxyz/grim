import { Router } from 'itty-router';
import { TelegramBot } from './telegram-bot';
import logger from './logger';

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  GRIM_SESSIONS: KVNamespace;
}

// Create a router
const router = Router();

// Helper function to read a preloaded scenario if available
async function readPreloadedScenario(env: Env): Promise<string | undefined> {
  if (!env.GRIM_SESSIONS) {
    logger.error('Cannot read preloaded scenario - KV namespace not available');
    console.error('Cannot read preloaded scenario - KV namespace not available');
    return undefined;
  }
  
  try {
    console.log('Attempting to read preloaded scenario from KV');
    const scenario = await env.GRIM_SESSIONS.get('preloaded_scenario');
    
    if (scenario) {
      console.log('Found preloaded scenario');
      logger.info('Found preloaded scenario', { 
        size: scenario.length,
        preview: scenario.substring(0, 50) + '...'
      });
      return scenario;
    } else {
      console.log('No preloaded scenario found');
      return undefined;
    }
  } catch (error) {
    console.error('Error reading preloaded scenario:', error);
    logger.error('Error reading preloaded scenario', { 
      error,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

// Helper function to create the webhook URL
function getWebhookUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/webhook`;
}

// Route to set up the Telegram webhook
router.get('/setup', async (request, env: Env) => {
  try {
    const preloadedScenario = await readPreloadedScenario(env);
    
    // Create bot instance
    const bot = new TelegramBot(
      env.TELEGRAM_BOT_TOKEN,
      env.ANTHROPIC_API_KEY,
      env.GRIM_SESSIONS,
      preloadedScenario
    );
    
    // Set the webhook URL
    const webhookUrl = getWebhookUrl(request);
    await bot.setWebhook(webhookUrl);
    
    return new Response(`Webhook set up successfully at ${webhookUrl}`, {
      status: 200
    });
  } catch (error) {
    logger.error('Failed to set up webhook', { error });
    return new Response('Failed to set up webhook: ' + (error as Error).message, {
      status: 500
    });
  }
});

// Route to remove the Telegram webhook
router.get('/remove-webhook', async (request, env: Env) => {
  try {
    // Create bot instance
    const bot = new TelegramBot(
      env.TELEGRAM_BOT_TOKEN,
      env.ANTHROPIC_API_KEY,
      env.GRIM_SESSIONS
    );
    
    // Delete the webhook
    await bot.deleteWebhook();
    
    return new Response('Webhook removed successfully', {
      status: 200
    });
  } catch (error) {
    logger.error('Failed to remove webhook', { error });
    return new Response('Failed to remove webhook: ' + (error as Error).message, {
      status: 500
    });
  }
});

// Route to store a preloaded scenario
router.post('/preload-scenario', async (request, env: Env) => {
  try {
    const scenario = await request.text();
    if (!scenario) {
      return new Response('No scenario provided', { status: 400 });
    }
    
    await env.GRIM_SESSIONS.put('preloaded_scenario', scenario, {
      expirationTtl: 60 * 60 * 24 * 7 // 7 days in seconds
    });
    
    return new Response('Scenario preloaded successfully', {
      status: 200
    });
  } catch (error) {
    logger.error('Failed to preload scenario', { error });
    return new Response('Failed to preload scenario: ' + (error as Error).message, {
      status: 500
    });
  }
});

// Route to handle Telegram webhook updates
router.post('/webhook', async (request, env: Env) => {
  console.log("=== STARTING WEBHOOK HANDLER IN WORKER ===");
  try {
    // Validate environment variables
    if (!env.TELEGRAM_BOT_TOKEN) {
      throw new Error("TELEGRAM_BOT_TOKEN is not defined");
    }
    
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not defined");
    }
    
    if (!env.GRIM_SESSIONS) {
      throw new Error("GRIM_SESSIONS KV namespace is not properly bound");
    }
    
    // Log request information
    console.log("Webhook request received:", {
      method: request.method,
      url: request.url
    });
    
    logger.info('Webhook request received', {
      method: request.method,
      url: request.url,
      contentType: request.headers.get('content-type'),
      contentLength: request.headers.get('content-length')
    });
    
    // Parse the incoming update
    let update;
    try {
      // Clone the request to preserve the body
      const requestClone = request.clone();
      const rawBody = await requestClone.text();
      
      // Only log a portion of the body for debugging
      console.log("Raw request body preview:", rawBody.substring(0, 200));
      
      // Parse the JSON
      update = JSON.parse(rawBody);
      
    } catch (parseError) {
      console.error("JSON parsing error:", parseError);
      logger.error('Failed to parse update JSON', { 
        error: parseError,
        errorMessage: (parseError as Error).message
      });
      
      return new Response('OK - Failed to parse, but OK response to prevent retries', { status: 200 });
    }
    
    console.log("Creating TelegramBot instance...");
    
    try {
      // Read any preloaded scenario
      const preloadedScenario = await readPreloadedScenario(env);
      
      // Create the bot instance
      const bot = new TelegramBot(
        env.TELEGRAM_BOT_TOKEN, 
        env.ANTHROPIC_API_KEY,
        env.GRIM_SESSIONS,
        preloadedScenario
      );
      
      console.log("Bot instance created, handling update...");
      
      // Process the update
      const result = await bot.handleUpdate(update);
      console.log("Update handled successfully");
      return result;
      
    } catch (botError) {
      console.error("Bot error:", botError);
      logger.error('Bot error', { 
        error: botError,
        errorMessage: (botError as Error).message,
        stack: (botError as Error).stack
      });
      
      return new Response('OK - Bot error, but OK response to prevent retries', { status: 200 });
    }
    
  } catch (error) {
    console.error("CRITICAL ERROR in webhook route:", error);
    logger.error('Critical error in webhook route', {
      message: (error as Error)?.message || 'Unknown error',
      name: (error as Error)?.name || 'Error',
      stack: (error as Error)?.stack
    });
    
    return new Response('OK - Critical error, but OK response to prevent retries', { status: 200 });
  } finally {
    console.log("=== ENDING WEBHOOK HANDLER IN WORKER ===");
  }
});

// Health check route
router.get('/health', () => {
  return new Response('OK', { status: 200 });
});

// Default route for anything else
router.all('*', () => {
  return new Response('Not Found', { status: 404 });
});

// Export the fetch handler for the Cloudflare Worker
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return router.handle(request, env, ctx);
  },
  
  // Optional: Add a scheduled handler for any maintenance tasks
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // This could be used for periodic tasks like cleaning up old sessions
    logger.info('Running scheduled task', { 
      scheduledTime: event.scheduledTime,
      cron: event.cron 
    });
    
    // Example: You could implement session cleanup here
  }
};