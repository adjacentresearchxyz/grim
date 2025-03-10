# Migration to Cloudflare Workers

This document outlines the changes made to migrate the GRIM application from a standalone Node.js application to a Cloudflare Workers deployment with KV storage.

## Changes Overview

1. **Storage Layer**
   - Added `CloudflareKVStorage` class to provide session persistence using Cloudflare KV
   - Implemented serialization/deserialization to handle KV limitations (no direct Map support)
   - Added support for session expiration via KV TTL settings

2. **Logger Adaptation**
   - Replaced Winston with a Cloudflare-compatible custom logger
   - Maintained the same logging interface for consistent usage throughout the codebase

3. **Telegram Bot Architecture**
   - Refactored bot into a class-based structure for better testability and initialization
   - Added webhook support for Cloudflare's serverless environment
   - Implemented request-based session management instead of in-memory storage

4. **Web API & Router**
   - Created a new `worker.ts` entry point with an HTTP router using itty-router
   - Added endpoints for webhook management, health checking, and scenario preloading
   - Implemented proper error handling and response formatting

5. **Configuration**
   - Added `wrangler.toml` for Cloudflare Workers configuration
   - Updated package.json with Cloudflare-related dependencies and scripts
   - Added TypeScript configuration for Cloudflare Workers

## Cloudflare-Specific Adaptations

1. **KV Instead of In-Memory Storage**
   - Each chat session is now stored in KV with a `chat_[id]` key format
   - Implemented session serialization to handle complex data structures
   - Added TTL for automatic cleanup of old sessions

2. **Webhook vs Long Polling**
   - Switched from long polling to webhook mode for Telegram updates
   - Added a `/setup` endpoint to configure the webhook URL
   - Implemented webhookCallback from the grammy library for processing updates

3. **Request-Scoped Bot Instances**
   - Each request creates a new bot instance rather than maintaining a singleton
   - Session state is loaded from KV at the start of each request
   - Changes are saved back to KV at the end of each request

4. **Environment Variables**
   - Switched from dotenv to Cloudflare's environment variable bindings
   - Configured secrets to be managed via wrangler

## Future Improvements

1. **Caching**
   - Add caching layer for frequently accessed data to reduce KV reads
   - Implement optimistic updates to improve performance

2. **Queue Processing**
   - Consider using Cloudflare's Durable Objects for more complex state management
   - Add a background queue for processing long-running LLM requests

3. **Monitoring & Logging**
   - Integrate with Cloudflare's analytics and monitoring tools
   - Add better error tracking and reporting

4. **Scaling**
   - Implement request coalescing for concurrent updates from the same chat
   - Add rate limiting to prevent abuse

## Deployment Instructions

See the updated README.md for detailed deployment instructions.