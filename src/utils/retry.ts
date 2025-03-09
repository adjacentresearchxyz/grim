import logger from '../logger';

/**
 * Configuration options for the retry mechanism
 */
export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Initial delay between retries in milliseconds */
  initialDelay: number;
  /** Multiplier to increase delay on each retry */
  backoffFactor: number;
  /** Optional function to determine if error is retriable */
  isRetriable?: (error: any) => boolean;
}

const defaultRetryOptions: RetryOptions = {
  maxRetries: 3,
  initialDelay: 1000,
  backoffFactor: 2,
  isRetriable: () => true
};

/**
 * Sleep for the specified duration
 * @param ms Time to sleep in milliseconds
 */
const sleep = (ms: number): Promise<void> => 
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wraps an async function with retry logic
 * @param fn The function to retry
 * @param options Retry configuration options
 * @returns A function that will retry on failure
 */
export const withRetry = <T, Args extends any[]>(
  fn: (...args: Args) => Promise<T>,
  options: Partial<RetryOptions> = {}
): ((...args: Args) => Promise<T>) => {
  const config = { ...defaultRetryOptions, ...options };
  
  return async (...args: Args): Promise<T> => {
    let lastError: any;
    let delay = config.initialDelay;
    
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          logger.info(`Retry attempt ${attempt}/${config.maxRetries}`, {
            functionName: fn.name,
            delay
          });
        }
        
        return await fn(...args);
      } catch (error) {
        lastError = error;
        
        const isRetriable = config.isRetriable?.(error);
        const hasAttemptsLeft = attempt < config.maxRetries;
        
        if (!isRetriable || !hasAttemptsLeft) {
          logger.error(`Error in ${fn.name}, no more retries`, {
            error,
            attempt,
            maxRetries: config.maxRetries
          });
          break;
        }
        
        logger.warn(`Temporary error in ${fn.name}, will retry`, {
          error: error instanceof Error ? error.message : error,
          attempt,
          nextDelay: delay
        });
        
        await sleep(delay);
        delay *= config.backoffFactor;
      }
    }
    
    throw lastError;
  };
};

/**
 * Example usage:
 * 
 * // For API calls that might fail due to rate limiting
 * const callAnthropicWithRetry = withRetry(
 *   anthropicClient.logAndCreateChatCompletion.bind(anthropicClient),
 *   {
 *     maxRetries: 5,
 *     initialDelay: 2000,
 *     isRetriable: (error) => {
 *       // Retry on rate limit errors or network issues
 *       return error.status === 429 || error.code === 'ECONNRESET';
 *     }
 *   }
 * );
 */
