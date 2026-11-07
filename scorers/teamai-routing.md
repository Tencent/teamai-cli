---
labels:
  - { value: fit, score: 1, description: "{{ skill.name }} is in skills.used, and the session needed what its description says." }
  - { value: idle, score: 1, description: "{{ skill.name }} is not in skills.used, and the session did not need what its description says, or another skill or the agent's own steps did it." }
  - { value: extra, score: 0, description: "{{ skill.name }} is in skills.used, and the session did not need what its description says." }
  - { value: missed, score: 0, description: "The session needed what the description of {{ skill.name }} says, {{ skill.name }} is not in skills.used, and nothing else did it." }
passingScore: 1
sessions: true
---

Judge only the team skill `{{ skill.name }}`, against its entry in `skills.available` in evidence.json.
