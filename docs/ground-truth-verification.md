# Ground-Truth Verification

The existing sim audits answer structural questions:

- is an item passive wired
- does a multi-hit ability emit the expected number of hits
- does a god/basic damage type resolve correctly

They do **not** answer the harder question:

> does this exact scenario match live game output

This repo now has a separate ground-truth layer for that.

## Commands

```bat
npm run verify:ground-truth
npm run audit:ground-truth
npm run audit:ground-truth-backlog
```

`verify:ground-truth` runs stored fixtures in [data/ground-truth-fixtures.json](../data/ground-truth-fixtures.json) and diffs the sim result against expected totals, timings, event counts, event values, and optional snapshot fields.

`audit:ground-truth` reports how much of the roster is actually covered by live fixtures and writes [data/ground-truth-coverage.json](../data/ground-truth-coverage.json).

`audit:ground-truth-backlog` writes [data/ground-truth-backlog.json](../data/ground-truth-backlog.json) with one missing god-area or item fixture entry per uncovered case, plus the matching local probe files to inspect while authoring the live fixture.

## Fixture format

Each fixture stores:

- `scenario`: the exact sim input
- `source`: where the live expectation came from
- `coverage`: which god areas or items this fixture is supposed to validate
- `totals`: optional total damage expectations
- `scalarAssertions`: optional timing expectations
- `eventCountAssertions`: how many matching damage events should exist
- `eventValueAssertions`: expected pre/post values for a specific matching event
- `snapshotAssertions`: optional stat snapshot checks

Example shapes:

- naked god basic
- single ability hit
- combo timing
- item proc count/value
- passive trigger on a follow-up cast

## Coverage standard

A god is only "fully covered" when live fixtures exist for:

- `basic`
- `passive`
- `A01`
- `A02`
- `A03`
- `A04`

An item is only counted as covered when it is listed explicitly in `coverage.items`. Merely appearing in a scenario build is not enough to claim that its passive/math was verified.

## Workflow

1. Capture the in-game case you want to trust.
2. Add or update a fixture in [data/ground-truth-fixtures.json](../data/ground-truth-fixtures.json).
3. Run `npm run verify:ground-truth`.
4. If it fails, fix the sim or tighten the fixture scenario.
5. Run `npm run audit:ground-truth` to see the remaining roster/item gaps.

This is the layer that prevents "wired" from being mistaken for "correct".
