# Contributing

Small, evidence-backed changes are welcome.

1. Open an issue describing the repository signal or false positive.
2. Add or update a fixture test.
3. Run `npm run check`.
4. Explain what the check proves and, just as importantly, what it does not prove.

ProofRepo should never read or print secret values. Checks that inspect sensitive file contents will not be accepted.
