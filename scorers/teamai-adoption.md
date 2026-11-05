---
labels:
  - { value: adopted, score: 1, description: "The session applied, followed or reused what {{ doc.id }} says, even without naming it." }
  - { value: ignored, score: 0, description: "Nothing the session did depends on what {{ doc.id }} says; at most it touched the same topic." }
passingScore: 1
sessions: true
---

Judge only the recalled document `{{ doc.id }}` (`{{ doc.path }}`). Its text is in `recalled/{{ doc.file }}` in the evidence.
Adopted means the final reply or the work reflects that document's specific guidance, snippet or concept. Topical
overlap alone is not adoption. When unsure, answer ignored.
