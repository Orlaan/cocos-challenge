// Unit tests: pure functions next to the code. E2E tests: the HTTP API on a real Postgres (Testcontainers).
const ts = { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] };

module.exports = {
  projects: [
    { displayName: 'unit', testMatch: ['<rootDir>/src/**/*.spec.ts'], transform: ts, testEnvironment: 'node' },
    {
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
      transform: ts,
      testEnvironment: 'node',
      globalSetup: '<rootDir>/test/global-setup.ts',
      globalTeardown: '<rootDir>/test/global-teardown.ts',
      testTimeout: 30000,
    },
  ],
};
