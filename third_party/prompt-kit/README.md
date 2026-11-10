# prompt-kit attribution

The local prompt and message primitives in `src/components/prompt-kit/` are adapted from [ibelick/prompt-kit](https://github.com/ibelick/prompt-kit), copyright 2025 Julien Thibeaut, MIT licensed. Retrieved 2026-10-21.

Sources:
- https://github.com/ibelick/prompt-kit/blob/main/components/prompt-kit/prompt-input.tsx
- https://github.com/ibelick/prompt-kit/blob/main/components/prompt-kit/message.tsx
- https://github.com/ibelick/prompt-kit/blob/main/LICENCE.md

Adaptations: native HTML controls and existing project CSS instead of shadcn/Tailwind; controlled input context; auto-growing textarea; composition-safe Chinese input; Shift+Enter newline; busy/empty submission protection; plain escaped text and explicit local result cards rather than a Markdown/HTML renderer. No upstream assets or branding are bundled.
