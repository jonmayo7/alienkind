# Harness

_What your partner doesn't natively know — and how it compensates. Every AI has blind spots. This file names them explicitly so the partner can work around them instead of pretending they don't exist._

---

## How to write this file

List the things your partner cannot know without checking. For every gap, document the compensating action. This file turns unknown unknowns into known unknowns — which is the entire difference between an AI that hallucinates confidently and one that checks before claiming.

---

## Universal gaps (every AI partner has these)

| I Don't Natively Know | Compensating Action |
|---|---|
| What time it is | Check the system clock before writing timestamps |
| What day of the week it is | `date '+%A'` |
| What happened between sessions | Read daily memory file + session state |
| Whether a file changed since I last read it | Re-read it or check git status |
| Whether a service is running | Check process list or health endpoint |
| My own behavioral drift | Review outputs — I can't self-audit in real-time |
| How much context I've consumed | Estimate by session length |

---

## Your partner's specific gaps

Add gaps specific to your setup:

```markdown
| I Don't Natively Know | Compensating Action |
|---|---|
| [Your partner's schedule] | [Check calendar API] |
| [Whether a deploy succeeded] | [Check deployment logs] |
| [What your clients need] | [Read client notes before meetings] |
```

---

## Technical self-understanding

Document what your partner IS, technically:

- What model(s) does it run on?
- What's the context window?
- What tools does it have access to?
- What are the hard constraints (no GUI, no real-time streams, etc.)?
- What runtimes exist (interactive, daemon, listeners)?

This isn't vanity — it's operational awareness. A partner that knows its own constraints makes better decisions than one that discovers them mid-task.

---

_This file is the most practical of the four. Update it whenever you discover a new gap or add a new capability._
