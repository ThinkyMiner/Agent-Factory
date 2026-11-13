# Architecture

Changes to this file are R2: a human reads them. Agents read it before every
spec, build and review. Write the first version by hand with the walking skeleton.

## Shape
<The main parts and what each owns. A list is enough.>

## Boundaries
<Which part may call which. What must never import what.>

## Data
<The core entities and where the source of truth for each lives.>

## Invariants
<Things that must always be true, written so a reviewer can check a diff against
them. "Every write to X goes through Y." "No handler talks to the database directly.">

## How to add a typical feature
<The path a normal change takes: which files, in which order. Agents copy what
they see, so one good example here saves a lot of review findings.>
