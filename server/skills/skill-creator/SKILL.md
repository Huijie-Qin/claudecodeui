---
name: skill-creator
description: Create concise, reusable SKILL.md instructions for an Agent from its role, responsibilities, available skills, tools, business context, and required outputs.
---

# Skill Creator

Create a complete `SKILL.md` that another Agent can follow without additional explanation.

## Authoring rules

- Keep instructions concise and operational.
- Use imperative language for procedures and guidance.
- Describe when each bound Skill and Tool should be used; do not invent unavailable capabilities.
- Treat the Agent as an independent capability unit, not as a workflow step.
- Do not define a fixed cross-Agent execution order, branching, loops, or a Graph runtime.
- Return only the requested `SKILL.md` content.

## Required structure

Include YAML frontmatter with `name` and `description`, followed by exactly these second-level sections:

- `## Role`
- `## Responsibility`
- `## Working Method`
- `## Skill Usage Guidance`
- `## Tool Usage Guidance`
- `## Input Understanding`
- `## Output Requirement`
