# Offline dependency version solver

`lib/solver.js` is a standalone, offline solver that sits next to the
semver implementation. Given a fixed catalog of candidate versions per
package, the dependency ranges required by each candidate, and a set of
root dependencies, it picks at most one version per package so that every
reachable constraint holds.

Scope and semantics:

- Only packages reachable from the roots are assigned a version.
- One global version per package. There is no npm-style nested
  (`node_modules`) installation and no peer dependency modeling.
- Membership tests reuse `Range` and `SemVer` from this repository,
  including the `includePrerelease` option.
- Candidate versions must be valid semver. Unknown dependency packages,
  invalid ranges, and duplicate candidates that are semantically equal
  (build metadata ignored) are rejected with an error.
- Build metadata is never used for comparisons; it is only kept as the
  original version identifier of a candidate.
- The input object is never modified, and the result does not depend on
  the key order of the input.

## Usage

```js
const solve = require('semver/lib/solver.js')

const result = solve({
  packages: {
    app: {
      versions: [
        { version: '2.0.0', dependencies: { lib: '^2.0.0' } },
        { version: '1.0.0', dependencies: { lib: '^1.0.0' } },
      ],
    },
    lib: {
      versions: [{ version: '2.0.0' }, { version: '1.5.0' }],
    },
  },
  roots: { app: '>=1.0.0', lib: '^1.0.0' },
  options: {
    includePrerelease: false, // forwarded to every Range
    budget: 10000,            // max candidate attempts, default Infinity
  },
})
```

Search order is deterministic: the next undecided package is the
lexicographically smallest reachable one, and its candidates are tried
highest version first. Conflicts backtrack to earlier choices; the
constraints introduced by a candidate are rolled back together with
that candidate, so abandoned branches never pollute later ones.
Dependency cycles are fine and can have solutions.

## Result shapes

- `{ status: 'solved', attempts, assignment: { name: version } }`
- `{ status: 'unsat', attempts, conflict }` where `conflict` contains
  the conflicted `package`, the active `constraints` with their
  `source` (`<root>` or `name@version`), a `path` of real constraints
  from a root down to the conflicted package, and a human-readable
  `message`. The conflict is verifiable against the input but is not
  guaranteed to be minimal.
- `{ status: 'budget', attempts, budget }` when the candidate-attempt
  budget ran out before a conclusion was reached.

## 90-second example

Run the bundled tour:

```console
$ node scripts/solver-example.js
```

It prints a successful selection (note the backtrack from `app@2.0.0`
to `app@1.0.0` so that `lib` can satisfy both roots), an unsatisfiable
input whose conflict report names the exact constraints and the source
path that activated them, and a run that stops when the attempt budget
is exhausted:

```
=== solved selection ===
{
  "status": "solved",
  "attempts": 7,
  "assignment": {
    "app": "1.0.0",
    "lib": "1.5.0"
  }
}

=== unsat with conflict source ===
{
  "status": "unsat",
  "attempts": 3,
  "conflict": {
    "package": "lib",
    "version": null,
    "reason": "no candidate version satisfies all constraints",
    "constraints": [
      {
        "range": "^1.0.0",
        "source": "<root>"
      },
      {
        "range": "^2.0.0",
        "source": "app@2.0.0"
      }
    ],
    "path": [
      {
        "from": "<root>",
        "package": "app",
        "range": ">=1.0.0"
      },
      {
        "from": "app@2.0.0",
        "package": "lib",
        "range": "^2.0.0"
      }
    ],
    "message": "cannot satisfy constraints on \"lib\": ^1.0.0 required by <root>, ^2.0.0 required by app@2.0.0. no candidate version satisfies all constraints"
  }
}

=== budget exhausted ===
{
  "status": "budget",
  "attempts": 7,
  "budget": 6
}
```
