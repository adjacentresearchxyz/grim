import { OpenAIService, DefaultOpenAIClient } from '../src/openai';
import { Player, UserInteraction, UserInteractionType } from '../src/types';

const openAIClient = new DefaultOpenAIClient(process.env.OPENAI_API_KEY || "");
const openAIService = new OpenAIService(openAIClient);

const rai = {
  id: 1,
  name: 'Rai',
  role: 'Head of Emergency Response'
};

const nuno = {
  id: 2,
  name: 'Nuño',
  role: 'Head of Foresight'
};

const players: Player[] = [
  rai,
  nuno,
];

const scenarioTopic = 'Social unrest due to unemployment from AI.';

const canonicalScenarioHistory = await openAIService.initializeScenario(scenarioTopic, players);

const mockActions: UserInteraction[] = [
  {
    type: UserInteractionType.ACTION,
    player: rai,
    content: '1 hour of research on what heads of state are saying about this.'
  },
  {
    type: UserInteractionType.ACTION,
    player: rai,
    content: '30 minutes of research into how the stock market is reacting'
  },
  {
    type: UserInteractionType.INFO,
    player: nuno,
    content: 'What is the unemployment rate in the US?'
  },
  {
    type: UserInteractionType.ACTION,
    player: nuno,
    content: '1 hour of messaging with friends and family about finding shelf-stable food, water, and being ready to shelter in place.'
  }
];

const result = await openAIService.processActions(canonicalScenarioHistory, mockActions);
for (const message of result) {
  console.log(message.role);
  console.log(message.content);
  console.log()
}
