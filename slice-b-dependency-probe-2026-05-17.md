## Slice B Dependency Probe Report

Date: 2026-05-17T22:42:14.555Z

### Full build error output
src/agents/beckett/beckettChecklistParser.ts(28,23): error TS2307: Cannot find module 'xlsx' or its corresponding type declarations.
src/agents/beckett/sweepOrchestrator.ts(44,8): error TS2307: Cannot find module '../cardboardConnection/cardboardConnectionUrlDiscovery.js' or its corresponding type declarations.
src/agents/beckett/sweepOrchestrator.ts(47,8): error TS2307: Cannot find module '../cardboardConnection/cardboardConnectionFetcher.js' or its corresponding type declarations.
src/agents/beckett/sweepOrchestrator.ts(50,8): error TS2307: Cannot find module '../cardboardConnection/cardboardConnectionParser.js' or its corresponding type declarations.

### npm package gaps
| Package | In root package.json | In main package.json | Recommendation |
|---|---|---|---|
| xlsx | yes (^0.18.5) | no | Add to Slice B package.json preservation set |

### Relative-path import gaps
| Importing file | Missing path | Location in root | Triage category | Recommendation |
|---|---|---|---|---|
| backend/src/agents/beckett/sweepOrchestrator.ts | ../cardboardConnection/cardboardConnectionUrlDiscovery.js | backend/src/agents/cardboardConnection/cardboardConnectionUrlDiscovery.ts | E | Add to Slice B (currently Category E) |
| backend/src/agents/beckett/sweepOrchestrator.ts | ../cardboardConnection/cardboardConnectionFetcher.js | backend/src/agents/cardboardConnection/cardboardConnectionFetcher.ts | E | Add to Slice B (currently Category E) |
| backend/src/agents/beckett/sweepOrchestrator.ts | ../cardboardConnection/cardboardConnectionParser.js | backend/src/agents/cardboardConnection/cardboardConnectionParser.ts | E | Add to Slice B (currently Category E) |

### Transitive dependency closure
- Slice B original count: 29
- After verification (Phase 3.1): 29 (all ABSENT or DIVERGENT-newer, kept)
- Plus transitive dependencies needed for build: 5 files
- Total minimum buildable set for proposed additions: 5

### Files needed (categorized by source)
- From Cat C Slice A (iOS): 0 files
- From Cat C Slice C (docs): 2 files
  - backend/src/agents/beckett/beckettChecklistParser.ts
  - backend/src/agents/beckett/brandRegistry.ts
- From Cat C Slice D (misc): 0 files
- From Cat D (scratch): 0 files
- From Cat E (config/secrets): 3 files
  - backend/src/agents/cardboardConnection/cardboardConnectionFetcher.ts
  - backend/src/agents/cardboardConnection/cardboardConnectionParser.ts
  - backend/src/agents/cardboardConnection/cardboardConnectionUrlDiscovery.ts
- From files that don't exist on disk: 0 files

### Dependency shape classification
- Shape: A
- Reasoning: Small additional file bundle needed and centered on cardboardConnection/beckett ingestion graph.

### Recommendation
- Expand Slice B to include cardboardConnection dependency files and preserve xlsx dependency delta in backend/package.json (plus lockfile update in that PR).

### Constraints
- No file contents modified
- No npm install attempted
- No commits or PRs
- Working tree state unchanged