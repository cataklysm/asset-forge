// The whole Drizzle schema in one module: `drizzle.config.ts` reads it from here, and the repositories import their
// tables from here. The tables live in `schema/`, one file per table family.
export * from './schema/workspace.js';
export * from './schema/assets.js';
export * from './schema/projects.js';
export * from './schema/files.js';
export * from './schema/workflows.js';
export * from './schema/tags.js';
export * from './schema/prompts.js';
export * from './schema/jobs.js';
export * from './schema/analysis.js';
export * from './schema/generations.js';
export * from './schema/site-crawls.js';
