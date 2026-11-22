---
name: etat
description: Relaylead status on a light model, read only - news, every open question as it is, missions not over.
model: haiku
disable-model-invocation: true
allowed-tools: Bash(relaylead brief)
---

Run `relaylead brief` once, then reply with its output as printed. Copy every open question exactly: mission, id, text, context, numbered options, the recommended one marked. Never summarize, reword or leave out a question. Run nothing else: to answer, launch, tell, merge or stop, the user uses `/relaylead`.
