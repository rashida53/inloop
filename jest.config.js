module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // .claude/worktrees/ is Claude Code's local agent state, which can hold
  // a duplicate copy of the codebase. Skip it so jest-haste-map doesn't
  // complain about module name collisions.
  testPathIgnorePatterns: ['/node_modules/', '/.claude/'],
  modulePathIgnorePatterns: ['<rootDir>/.claude/'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  clearMocks: true,
  resetModules: false,
  collectCoverageFrom: ['src/**/*.js', '!src/index.js'],
  coverageDirectory: 'coverage',
  // Quiet by default; pass --verbose to see per-test output.
  verbose: false,
};
