---
labels:
  - { value: correct, score: 1, description: The change meets every success criterion. }
  - { value: incorrect, score: 0, description: The change misses at least one success criterion. }
passingScore: 1
samplingRate: 100
---
Judge whether the change made from the starting commit, commits included, meets the success criteria.
Read the task to understand the intent, then the diff. Do not read the transcript. Decide only on the success criteria.

## Task

{{ task.prompt }}

## Success criteria

{{ task.successCriteria }}
