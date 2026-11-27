# Code style

The rules for code a person reads and extends by hand. They apply to all new code and are being applied to the
existing code package by package. A clean-up under these rules never changes behaviour: the tests stay as they
are, apart from imports and names they must follow.

## Functions

- A function serves one purpose, and its name says which. A function that does several things depending on a
  flag or an option is split into one function per thing.
- A function fits on a screen. A longer one is cut into named steps that read top-down: the caller tells the
  story, the steps hold the detail. As a guide, a body over about 40 lines wants splitting.
- A function that returns a promise is not defined inside another function. It lives at module level and gets
  what it needs as parameters, or as one explicit state or dependencies object. Small synchronous closures
  (a predicate, a mapper, an event listener of a few lines) may stay where they are used.
- A factory (`createX`) wires things together and returns the object; the work is done by module-level
  functions it calls.
- Nesting stays shallow: early returns instead of nested conditions, no nested ternaries.

## Documentation

Every function, method, class, interface and exported constant has a doc comment:

```ts
/**
 * What it does and, where it is not obvious, why.
 *
 * @param name what the caller passes
 * @returns what comes back; for a promise, what it resolves to
 * @throws which error, when a caller has to expect one
 */
```

`@param` and `@returns` are left out only where there is nothing to say (no parameters, returns nothing).
Comments inside a body explain a reason, never repeat the code. Existing comments that carry a reason or a
security rule are kept.

## Names

- Names are written out: `session`, not `s`; `request` and `response`, not `r`, `req` or `res`; `options`, not
  `o` or `opts`; `context`, not `ctx`; `dependencies`, not `deps`; `resourceClass`, not `rc`; `error`, not `e`.
- Established short forms stay, because writing them out would be the odd choice: URL, URI, ID, IPC, API,
  HTTP, JSON, SQL, MIME, UI, DOM, CSS, EXIF, the format names (PNG, ZIP, ...) and the units `Ms` and `Bytes`.
  `props` and `ref` stay in React code, `i` stays for a plain index.
- A name says what the value is, not what type it has. Booleans read as a statement (`isReady`, `hasApiKey`).
- Names that are stored or cross a boundary never change in a clean-up: database tables and columns, IPC
  channel names and the fields of their requests and answers, job types and error codes, keys in the JSON files
  under `userData`, payload fields of jobs.

## Files

- A file has one subject, and its name says which. Someone looking for one thing should find it by the file
  name, without reading a file that holds five other things.
- As a guide, a file over about 300 lines is checked for a second subject. Types that belong to one module live
  with it, not in a collection file.
- A package's `index.ts` only re-exports. Import paths of other packages stay stable through it.
- A split keeps git history readable: move code unchanged first where practical, then rework it.

## What a clean-up does not do

No behaviour change, no changed message text, no new dependency, no changed public channel or schema, no
"while I am here" fix. A bug or a doubtful spot found on the way goes into `docs/backlog.md`.
