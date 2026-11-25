// Test worker: fails while starting, with an error that names its own location.
throw new Error(`worker failed to start at ${import.meta.url}`);
