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
  try {
    const scenario = await env.GRIM_SESSIONS.get('preloaded_scenario');
    return scenario || undefined;
  } catch (error) {
    logger.error('Error reading preloaded scenario', { error });
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
  try {
    // Parse the incoming update
    const update = await request.json();
    
    // Create bot instance
    const preloadedScenario = await readPreloadedScenario(env);
    const bot = new TelegramBot(
      env.TELEGRAM_BOT_TOKEN,
      env.ANTHROPIC_API_KEY,
      env.GRIM_SESSIONS,
      preloadedScenario
    );
    
    // Handle the update
    await bot.handleUpdate(update);
    
    return new Response('OK', { status: 200 });
  } catch (error) {
    logger.error('Error handling webhook', { error });
    return new Response('Error handling webhook: ' + (error as Error).message, {
      status: 500
    });
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