---
description: Have the sous-chef taste it - hand tests for the current change (or the given scope) to the tester agent and follow the run
argument-hint: "[what to test, e.g. a feature, folder or file]"
---

Use the delegate-tests skill to hand tests to the tester agent.

Scope: $ARGUMENTS

If no scope is given, test the uncommitted changes in this project (`git status`, `git diff`).
Read the code under test first so the requirements are concrete, then start the run and follow it
to the end.
