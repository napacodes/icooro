// Preload module: set env before any other module runs.
// Loaded via `node --import ./test/setup-env.cjs`.
process.env.ICOORO_API_DISABLE_LISTENER = "1";
process.env.NODE_ENV = "test";
