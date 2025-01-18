import OpenAI from "openai";
import { Player } from "./types";
import logger from "./logger";
import { ChatCompletion, ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { UserAction } from "./types";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const maxIntelligenceModelParams: Pick<ChatCompletionCreateParamsNonStreaming, "model" | "reasoning_effort"> = { model: "o1", reasoning_effort: 'high' };

export const getPlayerDescription = (players: Player[]) =>
  players.map(p => `${p.name} - ${p.role}`).join('\n');

export const getInitialPrompt = (players: Player[]) => `You are an expert wargame facilitator, applying the best practices from military and other emergency response wargaming. Create a training scenario.

The players in the game are:
${getPlayerDescription(players)}

You will be given a scenario and your first message should set the stage of what is going on the in world, which may or may not clearly be a crisis. The end of the message should include the starting scenario datetime, current scenario datetime, and time offset since the beginning of the scenario (e.g. T+1day,12hours). All times should be in UTC. The first message should be at the beginning of the scenario and always have a time offset of T+0.

When answering questions and judging the results of our actions, assume we don't have any special resources. We are just a group of people distributed around the world with internet connections.
Think through the results of our actions step by step. For instance, you could assign probabilities to various outcomes and then sample from those proabilities.

Give concrete details when enthusiasts scanning the news would reasonably have the information but don't give information that would be hard to discover. For example, if you said: "International relations are tense due to unrelated trade disputes and technological competition.", that would be overly vague because it wouldn't be well known which specific countries have strained relationships and ongoing trade disputes. You should state specifics in cases like that. Do not create large fictious entities like countries or intergovernmental organizations. You are allowed to create some fictional small companies if the time is sufficiently far in the future, but you should prefer to use already-existing entities.

We will send various kinds of messages:
INFO: This is a request for information that we think we would already know about the world. It must not advance the scenario clock.
FEED: This is information that you should incorporate into the facts about the world. It must not advance the scenario clock.
ACTION: This is an action we take in the world. It may include getting information or taking other actions. We will include the time we would try to spend getting this information and the rough strategy we'd use. Given the strategy and time, simulate the degree to which it succeeds and incorporate the results in your next message. This can advance the scenario clock.

Each player can take actions concurrently with other players.
So for example, if these were the actions taken:

ACTION Alice: 2 hours to foo.
ACTION Bob: takes 3 hours to bar.
ACTION Charlie: takes 4 hours to baz.

You would advance the scenario clock by 2 hours since that is the smallest time and report on what has happened with the world and everyone's actions during that time. Everyone can then choose anew what they will do in the new state of the world, including continuing their previous action if it was in progress.

DO NOT TAKE ANY ACTIONS THAT ARE NOT EXPLICITLY INSTRUCTED BY THE PLAYERS.

Please begin the scenario.`;

interface Outcome {
  outcome: string;
  weight: number;
}

function sampleFromWeightedOutcomes(outcomes: Outcome[]): string {
  const totalWeight = outcomes.reduce((sum, o) => sum + o.weight, 0);
  const normalizedWeights = outcomes.map(o => o.weight / totalWeight);

  const rand = Math.random();
  let cumSum = 0;

  for (let i = 0; i < outcomes.length; i++) {
    cumSum += normalizedWeights[i];
    if (rand <= cumSum) {
      return outcomes[i].outcome;
    }
  }

  return outcomes[outcomes.length - 1].outcome;
}

async function loggedCompletionCreation(params: Parameters<typeof openai.chat.completions.create>[0]): Promise<ChatCompletion> {
  logger.debug("Requesting completion", { params });
  const completion = await openai.chat.completions.create({
    ...params,
    stream: false
  });
  logger.debug("Completion response", { completion });
  return completion as ChatCompletion;
}

export class OpenAIService {
  static async initializeScenario(scenario: string, players: Player[]): Promise<ChatCompletionMessageParam[]> {
    try {
      logger.info("Initializing scenario", {
        scenario,
        playerCount: players.length,
        players: players.map(p => ({ name: p.name, role: p.role }))
      });

      const gameMasterDeveloperMessage: ChatCompletionMessageParam = {
        role: "developer",
        content: getInitialPrompt(players)
      };

      const scenarioMessage: ChatCompletionMessageParam = {
        role: "user",
        content: scenario
      };

      logger.debug("Sending initial prompt to OpenAI", {
        messageLength: scenario.length
      });

      const completion = await loggedCompletionCreation({
        ...maxIntelligenceModelParams,
        messages: [gameMasterDeveloperMessage, scenarioMessage],
      });

      const response = completion.choices[0].message.content || "Failed to generate scenario";

      logger.info("Scenario initialized successfully", {
        responseLength: response.length
      });

      return [
        scenarioMessage,
        { role: "assistant", content: response }
      ];
    } catch (error) {
      logger.error("Failed to initialize scenario", {
        error,
        scenario,
        playerCount: players.length
      });
      throw error;
    }
  }

  static async chat(
    message: string,
    player: Player,
    history: ChatCompletionMessageParam[]
  ): Promise<ChatCompletionMessageParam[]> {
    try {
      logger.info("Processing chat message", {
        messageType: message.split(":")[0],
        playerName: player.name,
        historyLength: history.length
      });

      const newMessage: ChatCompletionMessageParam = {
        role: "user",
        content: message
      };

      logger.debug("Sending message to OpenAI", {
        messageLength: message.length,
        historyMessages: history.length
      });

      const completion = await loggedCompletionCreation({
        ...maxIntelligenceModelParams,
        messages: [...history, newMessage],
      });

      const response = completion.choices[0].message.content || "Failed to generate response";

      logger.info("Chat message processed successfully", {
        responseLength: response.length,
        newHistoryLength: history.length + 2
      });

      return [
        ...history,
        newMessage,
        { role: "assistant", content: response }
      ];
    } catch (error) {
      logger.error("Failed to process chat message", {
        error,
        messageType: message.split(":")[0],
        playerName: player.name,
        historyLength: history.length
      });
      throw error;
    }
  }

  static async processActions(
    canonicalScenarioMessages: ChatCompletionMessageParam[],
    actions: UserAction[],
  ): Promise<ChatCompletionMessageParam[]> {
    try {
      logger.info("Processing actions with forecaster");

      const forecasterDeveloperMessage: ChatCompletionMessageParam = {
        role: "developer",
        content: `You are a superforecaster specialized in analyzing complex scenarios and predicting outcomes with high calibration.
You are a master of coupling your fine-grained world-models and knowledge of base-rates with mathematical rules like Laplace's rule of succession and Bayes' rule.

You will see a few kinds of interactions from the players:
- FEED: This is information that you should incorporate into your model of the world and treat as true. The players do this so that they can correct your misunderstanding of the world in important ways. It must never consume any time in the world.
- ACTION: This is an action that the players take in the world. They will include the time they would try to spend getting this information and the rough strategy they'd use. Given the strategy and time, simulate the degree to which it succeeds and incorporate the results in your next message. This does advance the game clock.
- INFO: This is a request for information that would already know about the world. It must not advance the scenario clock.

For each player ACTION, INFO, and anything significant happening in the world concurrently, you should:
1. Analyze player actions and current scenario context
2. Break down possible outcomes into at least 3 possibilities
3. Sample from those outcomes using the tools/functions at your disposal to determine what happens
4. Incorporate the result into your response

When providing outcomes for actions, at the very least consider the following:
- Complexity of the action
- Available resources and capabilities
- Time constraints
- External factors and opposition
- Previous related events in the scenario`
      };

      logger.debug("actions", { actions });

      const forecastConfig = {
        ...maxIntelligenceModelParams,
        tool_choice: "required" as const,
        tools: [{
          type: "function" as const,
          function: {
            name: "sample_from_weighted_outcomes",
            description: "Randomly selects an outcome from a weighted list of possibilities",
            parameters: {
              type: "object",
              properties: {
                outcomes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      outcome: {
                        type: "string",
                        description: "The description of the outcome"
                      },
                      weight: {
                        type: "number",
                        description: "The weight/probability of this outcome"
                      }
                    },
                    required: ["outcome", "weight"]
                  }
                }
              },
              required: ["outcomes"]
            }
          }
        }],
      };

      const actionPromises = actions.map(async (action) => {
        const actionMessage: ChatCompletionMessageParam = {
          role: "user",
          content: `${action.type.toUpperCase()} ${action.player.name}: ${action.content}`
        };

        logger.debug("Processing individual action", {
          action: actionMessage.content
        });

        const completion = await loggedCompletionCreation({
          ...forecastConfig,
          messages: [forecasterDeveloperMessage, ...canonicalScenarioMessages, actionMessage],
        });

        const forecasterResponse = completion.choices[0].message;

        if (!forecasterResponse.tool_calls?.[0]) {
          logger.error("No tool call received when required", { forecasterResponse });
          return null;
        }

        const toolCall = forecasterResponse.tool_calls[0];
        const args = JSON.parse(toolCall.function.arguments);
        const { outcomes } = args;
        const outcome = sampleFromWeightedOutcomes(outcomes);

        logger.debug("Sampled outcome for action", {
          action: actionMessage.content,
          outcome,
          numOutcomes: outcomes.length
        });

        return `${actionMessage.content}\nOutcome: ${outcome}`;
      });

      const outcomes = await Promise.all(actionPromises);
      logger.debug("Outcomes", { outcomes });
      const allOutcomesStr = outcomes
        .filter((outcome): outcome is string => outcome !== null && outcome !== undefined)
        .join("\n\n");

      const gameMasterDeveloperMessage: ChatCompletionMessageParam = {
        role: "developer",
        content: `You are an expert wargame game master who will take all the information from this chat that the players should know and write them an update of what has happened in the world during the time that's elapsed and what the results of the players actions were. You will also tell them the results of the INFO messages they sent. Important note because previous iterations of you keep making this mistake: If only an hour has passed, it's very unlikely that the world has changed too much. At certain times during certain crises, news will come out quickly, but usually significant changes take at least days to unfold.
    
Just like the previous messages in the chat describing the world, you should include the scenario datetime and offset since the beginning of the scenario (e.g. T+1day,12hours). All times are in UTC.`
      };

      const gameMasterRequestMessage: ChatCompletionMessageParam = {
        role: "user",
        content: `Here are the actions the players took and their outcomes:\n${allOutcomesStr}`
      };

      logger.debug("Sending forecaster results to narrator", {
        messageLength: gameMasterRequestMessage.content.length
      });

      const narratorCompletion = await loggedCompletionCreation({
        ...maxIntelligenceModelParams,
        messages: [gameMasterDeveloperMessage, ...canonicalScenarioMessages, gameMasterRequestMessage],
      });

      const narratorResponse = narratorCompletion.choices[0].message.content || "Failed to generate narrative";

      logger.info("Narrator generated story update", {
        responseLength: narratorResponse.length
      });

      return [
        ...canonicalScenarioMessages,
        { role: "user", content: allOutcomesStr },
        { role: "assistant", content: narratorResponse }
      ];
    } catch (error) {
      logger.error("Failed to process actions", {
        error,
        actionCount: actions.length,
        historyLength: canonicalScenarioMessages.length
      });
      throw error;
    }
  }
} 
