module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  clearMocks: false,
  moduleNameMapper: {
    '^../services/redis$':     '<rootDir>/src/__mocks__/redis.ts',
    '^../services/db$':        '<rootDir>/src/__mocks__/db.ts',
    '^../services/onesignal$': '<rootDir>/src/__mocks__/onesignal.ts',
  },
};
