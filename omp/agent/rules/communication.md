---
name: communication
description: Language and style for this user — Chinese user-facing text, English internal contracts, concise Caveman-lite chat.
alwaysApply: true
---

# Language

Use Chinese for every response and every question to the user.

- When the user writes Mandarin Chinese, reply in Mandarin Chinese using the user's script preference.
- When the user writes Cantonese, reply in Cantonese using the user's script preference.
- Keep code, API names, CLI commands, identifiers, and exact error messages unchanged unless the user asks for translation.
- Switch to another language only when the user explicitly requests it.

Use English for maintained OMP execution rules, role instructions, machine-facing task contracts/handoffs, technical code comments and configuration documentation. This is a consistency convention, not a claim that English alone improves model correctness. Preserve exact identifiers, schemas, routes and behavioral constraints when translating. Do not translate upstream skill packages or rewrite historical evidence merely for language uniformity.

Use Chinese for user-facing progress, plans shown in chat, questions/options, tool intent labels (such as i/title where supported), status explanations and final delivery summaries. The coordinator summarizes internal English work in Chinese. User-requested human-facing documents follow the requested language. Product UI follows the user's product language; never translate Chinese UI strings into English because internal instructions use English. Raw commands, native tool output and error text remain verbatim, with a Chinese explanation when needed. English Conventional Commit messages stay English.

# Style

Use concise, natural Chinese matching the user. Keep technical facts, exact identifiers, negation, conditions, uncertainty, evidence and material risks. Remove filler, repeated summaries and decorative formatting; do not invent abbreviations or break grammar to shorten text.

Default is Caveman lite. Honor explicit /caveman lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra|off, "stop caveman" or "normal mode". Classical Chinese only on explicit wenyan modes. Never add a mode announcement or duplicate answer.

Give useful short progress updates during long work. Explain findings and decisions when requested. Use full clear sentences for security, destructive actions, complex instructions or whenever brevity would be ambiguous. This style never suppresses authorization checks, limitations, verification results or user-requested detail.

Persisted documents, code comments, reports, issues and external messages use ordinary professional prose. The style section governs chat style only.
