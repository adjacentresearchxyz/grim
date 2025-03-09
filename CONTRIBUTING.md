# Contributing to Grim

Thank you for your interest in contributing to Grim! This document provides guidelines and instructions to help you get started.

## Development Setup

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/YOUR-USERNAME/grim.git
   cd grim
   ```

2. **Install dependencies**
   ```bash
   # Install bun if you don't have it yet
   curl -fsSL https://bun.sh/install | bash
   
   # Install project dependencies
   bun install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your API keys
   ```
   You'll need:
   - A Telegram bot token (from [@BotFather](https://t.me/BotFather))
   - An Anthropic API key (from [console.anthropic.com](https://console.anthropic.com))

4. **Run the bot in development mode**
   ```bash
   bun src/grim.ts
   # With a custom scenario file
   bun src/grim.ts --scenario-file your_scenario.txt
   ```

## Code Style Guidelines

- Follow the functional programming style guidelines outlined in `.cursor/rules/prefer-functional-style.mdc`
- Use dependency injection as described in `.cursor/rules/depdendency-injection.mdc`
- For functions with more than 2 parameters, use a params object as outlined in `.cursor/rules/params.mdc`
- Use TypeScript for type safety
- Keep code well-documented with JSDoc comments for functions

## Pull Request Process

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes and commit them**
   ```bash
   git commit -m "Description of changes"
   ```

3. **Push to your fork**
   ```bash
   git push origin feature/your-feature-name
   ```

4. **Create a Pull Request**
   - Submit a PR from your fork to the main repository
   - Include a clear description of the changes
   - Reference any related issues

5. **Code Review**
   - Wait for the maintainers to review your PR
   - Address any feedback or requested changes

## Project Structure

- `src/` - Main source code
  - `grim.ts` - Entry point for the application
  - `anthropic.ts` - Interface with Anthropic API
  - `types.ts` - Type definitions
  - `logger.ts` - Logging utilities
  - `utils/` - Utility functions
- `scripts/` - Utility scripts
- `test/` - Test files

## Testing

Before submitting a PR, ensure that:

1. The bot starts without errors
2. New features work as expected
3. Any bugs are fixed and don't reoccur

We're working on adding automated tests, and contributions to improve test coverage are welcome!

## Questions?

Feel free to ask for clarification in issues or request a call by emailing [hello@sentinel-team.org](mailto:hello@sentinel-team.org).
