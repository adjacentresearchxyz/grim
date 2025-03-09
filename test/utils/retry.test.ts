/**
 * Unit tests for the retry utility
 * 
 * To run:
 * bun test test/utils/retry.test.ts
 */

import { describe, expect, it, jest, beforeEach } from 'bun:test';
import { withRetry } from '../../src/utils/retry';

// Mock the logger to avoid console output during tests
jest.mock('../../src/logger', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
}));

describe('retry utility', () => {
  // Avoid real delays in tests
  beforeEach(() => {
    global.setTimeout = jest.fn((callback) => {
      callback();
      return 0 as any;
    });
  });

  it('should return the result if the function succeeds on first try', async () => {
    // Arrange
    const mockFn = jest.fn().mockResolvedValue('success');
    const retryFn = withRetry(mockFn, { maxRetries: 3 });
    
    // Act
    const result = await retryFn('arg1', 'arg2');
    
    // Assert
    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledWith('arg1', 'arg2');
  });

  it('should retry when function fails and then succeed', async () => {
    // Arrange
    const mockFn = jest.fn()
      .mockRejectedValueOnce(new Error('Temporary error'))
      .mockResolvedValueOnce('success after retry');
    
    const retryFn = withRetry(mockFn, { maxRetries: 3, initialDelay: 100 });
    
    // Act
    const result = await retryFn();
    
    // Assert
    expect(result).toBe('success after retry');
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should throw after exhausting all retries', async () => {
    // Arrange
    const error = new Error('Persistent error');
    const mockFn = jest.fn().mockRejectedValue(error);
    const retryFn = withRetry(mockFn, { maxRetries: 2, initialDelay: 100 });
    
    // Act & Assert
    await expect(retryFn()).rejects.toThrow(error);
    expect(mockFn).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });

  it('should not retry if isRetriable returns false', async () => {
    // Arrange
    const error = new Error('Non-retriable error');
    const mockFn = jest.fn().mockRejectedValue(error);
    const isRetriable = jest.fn().mockReturnValue(false);
    
    const retryFn = withRetry(mockFn, { 
      maxRetries: 3, 
      initialDelay: 100,
      isRetriable
    });
    
    // Act & Assert
    await expect(retryFn()).rejects.toThrow(error);
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(isRetriable).toHaveBeenCalledTimes(1);
    expect(isRetriable).toHaveBeenCalledWith(error);
  });

  it('should apply backoff factor to delays', async () => {
    // Arrange - Restore setTimeout to track delay values
    const mockSetTimeout = jest.fn((callback, ms) => {
      callback();
      return 0 as any;
    });
    global.setTimeout = mockSetTimeout;
    
    const mockFn = jest.fn()
      .mockRejectedValueOnce(new Error('Error 1'))
      .mockRejectedValueOnce(new Error('Error 2'))
      .mockResolvedValueOnce('success');
    
    const retryFn = withRetry(mockFn, { 
      maxRetries: 2, 
      initialDelay: 1000,
      backoffFactor: 2
    });
    
    // Act
    await retryFn();
    
    // Assert
    expect(mockSetTimeout).toHaveBeenCalledTimes(2);
    expect(mockSetTimeout.mock.calls[0][1]).toBe(1000); // First retry
    expect(mockSetTimeout.mock.calls[1][1]).toBe(2000); // Second retry (1000 * 2)
  });
});
