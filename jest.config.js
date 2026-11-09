// Unit tests: pure functions next to the code. E2E tests: the HTTP API on a real Postgres (Testcontainers).
const ts = { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] };
// restoreMocks: a spy that a failed test never used cannot leak into the next test of the same file.
const common = { transform: ts, testEnvironment: 'node', restoreMocks: true };

module.exports = {
  projects: [
    { displayName: 'unit', testMatch: ['<rootDir>/src/**/*.spec.ts'], ...common },
    {
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
      ...common,
      globalSetup: '<rootDir>/test/global-setup.ts',
      globalTeardown: '<rootDir>/test/global-teardown.ts',
      testTimeout: 30000,
    },
  ],
};
