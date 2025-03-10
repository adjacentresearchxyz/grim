import { ChatCompletionMessageParam } from "./anthropic";
import { Player, UserInteraction } from "./types";
import logger from "./logger";

export interface ScenarioState {
  isActive: boolean;
  messages: Array<ChatCompletionMessageParam>;
}

export interface SessionData {
  roleAssignments: Map<number, Player>;
  scenarioState: ScenarioState;
  actionQueue: UserInteraction[];
  scenarioCheckpoints: Map<string, ScenarioState>;
}

// For KV serialization - Map is not directly serializable
export interface SerializableSessionData {
  roleAssignments: Record<string, Player>;
  scenarioState: ScenarioState;
  actionQueue: UserInteraction[];
  scenarioCheckpoints: Record<string, ScenarioState>;
}

export interface SessionStorage {
  get(key: string): Promise<SessionData | undefined>;
  set(key: string, data: SessionData): Promise<void>;
  delete(key: string): Promise<void>;
}

// Helper functions to convert between Map and Record for serialization
export function serializeSessionData(data: SessionData): SerializableSessionData {
  const roleAssignmentsObj: Record<string, Player> = {};
  data.roleAssignments.forEach((value, key) => {
    roleAssignmentsObj[key.toString()] = value;
  });

  const checkpointsObj: Record<string, ScenarioState> = {};
  data.scenarioCheckpoints.forEach((value, key) => {
    checkpointsObj[key] = value;
  });

  return {
    roleAssignments: roleAssignmentsObj,
    scenarioState: data.scenarioState,
    actionQueue: data.actionQueue,
    scenarioCheckpoints: checkpointsObj
  };
}

export function deserializeSessionData(data: SerializableSessionData): SessionData {
  const roleAssignmentsMap = new Map<number, Player>();
  Object.entries(data.roleAssignments).forEach(([key, value]) => {
    roleAssignmentsMap.set(parseInt(key, 10), value);
  });

  const checkpointsMap = new Map<string, ScenarioState>();
  Object.entries(data.scenarioCheckpoints).forEach(([key, value]) => {
    checkpointsMap.set(key, value);
  });

  return {
    roleAssignments: roleAssignmentsMap,
    scenarioState: data.scenarioState,
    actionQueue: data.actionQueue,
    scenarioCheckpoints: checkpointsMap
  };
}

// Initial session data function
export function getInitialSessionData(): SessionData {
  return {
    roleAssignments: new Map(),
    scenarioState: {
      isActive: false,
      messages: []
    },
    actionQueue: [],
    scenarioCheckpoints: new Map()
  };
}

export class CloudflareKVStorage implements SessionStorage {
  private kvNamespace: KVNamespace;
  private prefix: string;

  constructor(kvNamespace: KVNamespace, prefix: string = 'session:') {
    this.kvNamespace = kvNamespace;
    this.prefix = prefix;
  }

  private getFullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<SessionData | undefined> {
    try {
      // Check if KV namespace is properly initialized
      if (!this.kvNamespace) {
        logger.error(`KV namespace is not properly initialized`, { key });
        console.error("KV namespace is not properly initialized");
        return undefined;
      }
      
      const fullKey = this.getFullKey(key);
      logger.debug(`Attempting to get data for key: ${fullKey}`);
      console.log(`Attempting to get data for key: ${fullKey}`);
      
      const data = await this.kvNamespace.get(fullKey, 'json') as SerializableSessionData | null;
      
      if (!data) {
        logger.debug(`No session found for key: ${key}`);
        return undefined;
      }
      
      return deserializeSessionData(data);
    } catch (error) {
      logger.error(`Error retrieving session for key: ${key}`, { 
        error, 
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      console.error(`Error retrieving session for key: ${key}`, error);
      return undefined;
    }
  }

  async set(key: string, data: SessionData): Promise<void> {
    try {
      // Check if KV namespace is properly initialized
      if (!this.kvNamespace) {
        const kvError = new Error("KV namespace is not properly initialized");
        logger.error(`Cannot store session: KV namespace is not properly initialized`, { key });
        console.error("KV namespace is not properly initialized");
        throw kvError;
      }
      
      const fullKey = this.getFullKey(key);
      const serializedData = serializeSessionData(data);
      
      logger.debug(`Attempting to store data for key: ${fullKey}`);
      console.log(`Attempting to store data for key: ${fullKey}`);
      
      // Set with expiration (30 days)
      await this.kvNamespace.put(fullKey, JSON.stringify(serializedData), {
        expirationTtl: 60 * 60 * 24 * 30 // 30 days in seconds
      });
      
      logger.debug(`Session stored for key: ${key}`);
    } catch (error) {
      logger.error(`Error storing session for key: ${key}`, { 
        error, 
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      console.error(`Error storing session for key: ${key}`, error);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      // Check if KV namespace is properly initialized
      if (!this.kvNamespace) {
        const kvError = new Error("KV namespace is not properly initialized");
        logger.error(`Cannot delete session: KV namespace is not properly initialized`, { key });
        console.error("KV namespace is not properly initialized");
        throw kvError;
      }
      
      const fullKey = this.getFullKey(key);
      logger.debug(`Attempting to delete data for key: ${fullKey}`);
      console.log(`Attempting to delete data for key: ${fullKey}`);
      
      await this.kvNamespace.delete(fullKey);
      logger.debug(`Session deleted for key: ${key}`);
    } catch (error) {
      logger.error(`Error deleting session for key: ${key}`, { 
        error, 
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      console.error(`Error deleting session for key: ${key}`, error);
      throw error;
    }
  }
}