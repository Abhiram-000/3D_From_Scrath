<!--
  The AI tutor panel (`05`): personas, streaming-shaped replies, scroll discipline.

  Rules this component holds:
   - the persona is a teaching stance sent per-message; switching is instant, the knowledge is not;
   - a typing indicator shows work honestly while the request is in flight;
   - the list auto-scrolls only when the learner is already near the bottom — "reading older messages
     must never be interrupted by an incoming reply";
   - every reply renders as text nodes. A constrained **bold** renderer is applied on escaped text,
     never innerHTML of raw model output.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import type { ChatPersona, ModelContext } from '@edu3d/contracts';
  import { apiFetch } from '$lib/core/api.ts';

  interface Message {
    id: number;
    role: 'user' | 'assistant';
    text: string;
  }

  const PERSONAS: ReadonlyArray<{ id: ChatPersona; label: string }> = [
    { id: 'teacher', label: 'Teacher — warm, analogy-driven' },
    { id: 'buddy', label: 'Study buddy — casual peer' },
    { id: 'engineer', label: 'Engineer — cites real values' },
    { id: 'eli5', label: 'ELI5 — tiny words' },
    { id: 'socratic', label: 'Socratic — guiding questions' },
  ];

  let messages = $state<Message[]>([
    {
      id: 0,
      role: 'assistant',
      text: 'I can see the model you have open. Ask me anything about it — or tap a suggestion to start.',
    },
  ]);
  let input = $state('');
  let persona = $state<ChatPersona>('teacher');
  let thinking = $state(false);
  let nearBottom = $state(true);
  let showScrollButton = $state(false);

  let listElement: HTMLElement | null = $state(null);
  let sequence = 1;

  /** The remembered persona preference (`05`). */
  $effect(() => {
    try {
      const saved = localStorage.getItem('edu3d.persona');
      if (saved && PERSONAS.some((entry) => entry.id === saved)) persona = saved as ChatPersona;
    } catch {
      /* session-only persona */
    }
  });

  function rememberPersona() {
    try {
      localStorage.setItem('edu3d.persona', persona);
    } catch {
      /* fine */
    }
  }

  function onScroll() {
    if (!listElement) return;
    const distance = listElement.scrollHeight - listElement.scrollTop - listElement.clientHeight;
    nearBottom = distance < 60;
    showScrollButton = distance > 160;
  }

  async function scrollToBottom(smooth = true) {
    await tick();
    listElement?.scrollTo({ top: listElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  /** Chips seeded from the model's own content — "the learner's first question is the hardest" (`05`). */
  let suggestions = $state<string[]>([]);

  export function seedFromModel(context: ModelContext) {
    suggestions = [
      ...context.parts.slice(0, 2).map((part) => `What does the ${part.name.toLowerCase()} do?`),
      ...(context.parameters[0]
        ? [`What happens when I change ${context.parameters[0].label.toLowerCase()}?`]
        : []),
      'Explain the main idea in one sentence',
    ].slice(0, 4);
  }

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (content.length === 0 || thinking) return;
    input = '';
    messages = [...messages, { id: sequence++, role: 'user', text: content }];
    thinking = true;
    if (nearBottom) void scrollToBottom();

    const history = messages
      .filter((message) => message.id !== 0)
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.text }));

    const result = await apiFetch<{ text: string }>('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: content, persona, history, stream: false }),
    });

    thinking = false;
    if (result.ok) {
      messages = [...messages, { id: sequence++, role: 'assistant', text: result.data.text }];
    } else {
      // The input is never lost; the learner can edit and resend (`05`).
      input = content;
      messages = [
        ...messages,
        {
          id: sequence++,
          role: 'assistant',
          text: `${result.message} Your message is back in the box — try again in a moment.`,
        },
      ];
    }
    if (nearBottom) void scrollToBottom();
  }

  /** Escaped text with a constrained bold renderer — never raw HTML (`05` trust rule). */
  function render(text: string): Array<{ bold: boolean; text: string }> {
    // Split on **bold** spans: odd indices are the bold segments, even ones plain text. Svelte's
    // {text} interpolation escapes by construction, so nothing here can execute.
    const out: Array<{ bold: boolean; text: string }> = [];
    text.split(/\*\*(.+?)\*\*/g).forEach((part, index) => {
      if (part.length > 0) out.push({ bold: index % 2 === 1, text: part });
    });
    return out;
  }
</script>

<div class="chat">
  <label class="persona-label" for="persona-select">Tutor style</label>
  <select
    id="persona-select"
    class="persona-select"
    bind:value={persona}
    onchange={rememberPersona}
  >
    {#each PERSONAS as entry (entry.id)}
      <option value={entry.id}>{entry.label}</option>
    {/each}
  </select>

  <div
    class="messages"
    bind:this={listElement}
    onscroll={onScroll}
    aria-live="polite"
  >
    {#each messages as message (message.id)}
      <div class="message {message.role}">
        <span class="avatar" aria-hidden="true">{message.role === 'user' ? 'You' : 'AI'}</span>
        <div class="bubble">
          {#each render(message.text) as part, index (index)}
            {#if part.bold}<strong>{part.text}</strong>{:else}{part.text}{/if}
          {/each}
        </div>
      </div>
    {/each}
    {#if thinking}
      <div class="message assistant">
        <span class="avatar" aria-hidden="true">AI</span>
        <div class="bubble typing"><span></span><span></span><span></span></div>
      </div>
    {/if}
  </div>

  {#if showScrollButton}
    <button class="scroll-down" onclick={() => scrollToBottom()} aria-label="Scroll to latest message">↓</button>
  {/if}

  {#if suggestions.length > 0}
    <div class="suggestions">
      {#each suggestions as suggestion (suggestion)}
        <button class="chip" onclick={() => send(suggestion)}>{suggestion}</button>
      {/each}
    </div>
  {/if}

  <form
    class="composer"
    onsubmit={(event) => {
      event.preventDefault();
      void send();
    }}
  >
    <label class="sr-only" for="chat-input">Ask a question</label>
    <input
      id="chat-input"
      placeholder="Ask about this model…"
      autocomplete="off"
      bind:value={input}
      onkeydown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void send();
        }
      }}
    />
    <button class="send" type="submit" disabled={thinking || input.trim().length === 0} aria-label="Send message">
      ➤
    </button>
  </form>
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-height: 0;
    flex: 1;
  }

  .persona-label {
    font-size: var(--text-xs);
    color: var(--text-subtle);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .persona-select {
    width: 100%;
    padding: var(--space-1) var(--space-2);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: var(--text-sm);
  }

  .messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-1) 0;
    scroll-behavior: smooth;
  }

  .message {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
  }

  .message.user {
    flex-direction: row-reverse;
  }

  .avatar {
    flex-shrink: 0;
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border-radius: var(--radius-full);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 0.5625rem;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .bubble {
    max-width: 85%;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--surface);
    border: 1px solid var(--border);
    font-size: var(--text-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .message.user .bubble {
    background: var(--accent-soft);
    border-color: var(--accent-ring);
  }

  .typing {
    display: flex;
    gap: 4px;
    padding: var(--space-3);
  }

  .typing span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-subtle);
    animation: typing-bounce 1.2s ease-in-out infinite;
  }

  .typing span:nth-child(2) {
    animation-delay: 0.15s;
  }

  .typing span:nth-child(3) {
    animation-delay: 0.3s;
  }

  @keyframes typing-bounce {
    0%,
    80%,
    100% {
      transform: translateY(0);
      opacity: 0.4;
    }
    40% {
      transform: translateY(-4px);
      opacity: 1;
    }
  }

  .scroll-down {
    position: absolute;
    right: var(--space-3);
    bottom: 6.5rem;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-full);
    background: var(--glass-bg);
    border: 1px solid var(--border-strong);
    color: var(--text);
    backdrop-filter: blur(10px);
    z-index: 3;
  }

  .suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .chip {
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--surface);
    color: var(--text-muted);
    font-size: var(--text-xs);
    transition: color var(--duration-fast) ease, border-color var(--duration-fast) ease;
  }

  .chip:hover {
    color: var(--text);
    border-color: var(--accent-ring);
  }

  .composer {
    display: flex;
    gap: var(--space-2);
  }

  .composer input {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.75rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: var(--text-sm);
  }

  .composer input:focus {
    outline: none;
    border-color: var(--accent-ring);
  }

  .send {
    width: 38px;
    border-radius: var(--radius-sm);
    background: var(--gradient-accent);
    color: var(--accent-contrast);
    font-size: 0.9375rem;
  }

  .send:disabled {
    opacity: 0.5;
  }
</style>
