import { OpenAIService } from '../src/openai';
import { Player } from '../src/types';
import { UserAction } from '../src/types';

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

const canonicalScenarioHistory = await OpenAIService.initializeScenario(scenarioTopic, players);

const mockActions: UserAction[] = [
  {
    type: 'action',
    player: rai,
    content: '1 hour of research on what heads of state are saying about this.'
  },
  {
    type: 'action',
    player: rai,
    content: '30 minutes of research into how the stock market is reacting'
  },
  {
    type: 'info',
    player: nuno,
    content: 'What is the unemployment rate in the US?'
  },
  {
    type: 'action',
    player: nuno,
    content: '1 hour of messaging with friends and family about finding shelf-stable food, water, and being ready to shelter in place.'
  }
];

const result = await OpenAIService.processActions(canonicalScenarioHistory, mockActions);
for (const message of result) {
  console.log(message.role);
  console.log(message.content);
  console.log()
}
