<!--
  The AI tutor panel — V1's exact chat markup and behavior.

  Class-for-class with V1's index.html chat block: .chat-controls with the persona select (named
  personas: "Teacher — Professor Paradox" etc.), .chat-messages with .message-avatar +
  .message-bubble + .message-meta timestamps, the .scroll-to-bottom button, and the composer with
  suggestion chips and the gradient send button. The stylesheet (viewer.css) styles all of it.

  Behavior per `05`: the persona is a teaching stance sent per-message; a typing indicator shows
  work honestly; auto-scroll only when already near the bottom; Enter sends; errors return the
  input; all text renders as text nodes with a constrained bold renderer.

  The persona has ONE home: `UserSettings.chatPersona` in contracts (stored under
  `edu3d.settings.v1` via lib/core/settings.ts). The old competing `edu3d.persona` localStorage key
  was a second, silent home for the same decision — the two could disagree after a settings edit,
  and whichever the panel read last won invisibly. It is read once here to migrate a choice made
  under the old key, then deleted; the settings schema validates and persists from then on.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { ChatPersona, ModelManifest } from '@edu3d/contracts';
  import { chatStream } from '$lib/core/api.ts';
  import { SettingsStore } from '$lib/core/settings.ts';
  import { toContext } from '$lib/core/model-context.ts';

  const {
    manifest,
    selectedPart = null,
  }: { manifest: ModelManifest | null; selectedPart?: string | null } = $props();

  const PERSONAS: ReadonlyArray<{ id: ChatPersona; label: string }> = [
    { id: 'teacher', label: 'Teacher — Professor Paradox' },
    { id: 'buddy', label: 'Study Buddy — Friendly & Casual' },
    { id: 'engineer', label: 'Engineer — Technical Details' },
    { id: 'eli5', label: "ELI5 — Explain Like I'm 5" },
    { id: 'socratic', label: 'Socratic — Learn Through Questions' },
  ];

  interface Message {
    id: number;
    role: 'user' | 'assistant';
    text: string;
    timestamp: string;
  }

  const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let messages = $state<Message[]>([
    {
      id: 0,
      role: 'assistant',
      text: "Hello! I'm your AI learning assistant. Ask me anything about this topic.\n\nI can explain concepts, answer questions, or help you understand the 3D model.",
      timestamp: now(),
    },
  ]);
  let input = $state('');
  /**
   * The teaching stance — a setting, not a panel-local preference. `UserSettings.chatPersona` is
   * its single home; the store validates every change and persists it, so a persona survives a
   * reload exactly as any other setting does.
   */
  const settings = new SettingsStore();
  let persona = $state<ChatPersona>(settings.current.chatPersona);
  let thinking = $state(false);
  /**
   * The id of the assistant bubble currently being streamed into, once its first delta has created
   * it. Null means "no text yet" — the typing indicator still owns the moment (`05`): a tutor that
   * shows dots, then letters, reads as thinking-then-writing; one that shows an empty bubble does not.
   */
  let streamingId = $state<number | null>(null);
  let nearBottom = $state(true);
  let showScrollButton = $state(false);

  let messagesElement: HTMLElement | null = $state(null);
  let sequence = 1;

  onMount(() => {
    // One-shot migration off the old competing key: honour the choice it holds, then remove it so
    // `edu3d.persona` cannot come back as a second home for this decision.
    try {
      const legacy = localStorage.getItem('edu3d.persona');
      if (legacy !== null) localStorage.removeItem('edu3d.persona');
      if (
        legacy &&
        PERSONAS.some((entry) => entry.id === legacy) &&
        legacy !== settings.current.chatPersona
      ) {
        persona = settings.update({ chatPersona: legacy as ChatPersona }).chatPersona;
      }
    } catch {
      /* storage unavailable: the schema default stands */
    }
  });

  /** The select changed: validate and persist through the settings store, then show what it kept. */
  function rememberPersona() {
    persona = settings.update({ chatPersona: persona }).chatPersona;
  }

  function onScroll() {
    if (!messagesElement) return;
    const distance =
      messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight;
    nearBottom = distance < 60;
    showScrollButton = distance > 160;
  }

  async function scrollToBottom(smooth = true) {
    await tick();
    messagesElement?.scrollTo({
      top: messagesElement.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  /** Suggestion chips seeded from the model's own content (`05`). */
  const suggestions = $derived.by(() => {
    if (!manifest)
      return ['Explain this concept', 'How does this work?', 'What are the key principles?'];
    const context = toContext(manifest, selectedPart);
    return [
      ...context.parts.slice(0, 2).map((part) => `What does the ${part.name.toLowerCase()} do?`),
      ...(context.parameters[0]
        ? [`What happens when I change ${context.parameters[0].label.toLowerCase()}?`]
        : []),
      'Explain the main idea in one sentence',
    ].slice(0, 4);
  });

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (content.length === 0 || thinking) return;
    input = '';
    messages = [...messages, { id: sequence++, role: 'user', text: content, timestamp: now() }];
    thinking = true;
    if (nearBottom) void scrollToBottom();

    const history = messages
      .filter((message) => message.id !== 0)
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.text }));

    try {
      // The tutor streams (`05`): the answer bubble is created on the first delta and grown with
      // each fragment, so the learner watches it write instead of waiting out a silent call. The
      // composer stays disabled (via `thinking`) until the ONE terminal event lands.
      const outcome = await chatStream({
        message: content,
        persona,
        history,
        context: manifest ? toContext(manifest, selectedPart) : undefined,
        onDelta: (fragment) => {
          if (streamingId === null) {
            streamingId = sequence++;
            messages = [
              ...messages,
              { id: streamingId, role: 'assistant', text: fragment, timestamp: now() },
            ];
          } else {
            const id = streamingId;
            messages = messages.map((message) =>
              message.id === id ? { ...message, text: message.text + fragment } : message,
            );
          }
          // Keep the newest text in view, but only for a learner already at the bottom (`05`).
          if (nearBottom) void scrollToBottom(false);
        },
      });

      if (outcome.ok) {
        // The terminal `done` carries the authoritative text; the accumulated deltas were the view.
        finishReply(outcome.text);
      } else {
        // A retriable rate limit is tellable: the server's own wait goes in the same sentence. A
        // mid-stream failure keeps any partial answer and appends the honest error to it.
        const wait = outcome.retryAfterSeconds
          ? ` Try again in about ${outcome.retryAfterSeconds}s.`
          : '';
        input = content;
        const notice = `${outcome.message}${wait} Your message is back in the box — try again in a moment.`;
        finishReply(
          streamingId !== null
            ? `${messages.find((message) => message.id === streamingId)?.text ?? ''}\n\n${notice}`
            : notice,
        );
      }
    } finally {
      // The terminal event — success, error or cancellation — is what re-enables the composer.
      thinking = false;
      streamingId = null;
      if (nearBottom) void scrollToBottom();
    }
  }

  /** Close the in-progress bubble with its final text, creating it if no delta ever arrived. */
  function finishReply(finalText: string) {
    if (streamingId !== null) {
      const id = streamingId;
      messages = messages.map((message) =>
        message.id === id ? { ...message, text: finalText } : message,
      );
    } else {
      messages = [
        ...messages,
        { id: sequence++, role: 'assistant', text: finalText, timestamp: now() },
      ];
    }
  }

  /** Escaped text with a constrained **bold** renderer — never raw HTML (`05` trust rule). */
  function render(text: string): Array<{ bold: boolean; text: string }> {
    const out: Array<{ bold: boolean; text: string }> = [];
    text.split(/\*\*(.+?)\*\*/g).forEach((part, index) => {
      if (part.length > 0) out.push({ bold: index % 2 === 1, text: part });
    });
    return out;
  }
</script>

<div class="chat-container">
  <div class="chat-controls">
    <label class="chat-mode-label" for="chatModeSelector">Tutor style</label>
    <select
      id="chatModeSelector"
      class="chat-mode-select"
      bind:value={persona}
      onchange={rememberPersona}
    >
      {#each PERSONAS as entry (entry.id)}
        <option value={entry.id}>{entry.label}</option>
      {/each}
    </select>
  </div>

  <div class="chat-messages" bind:this={messagesElement} onscroll={onScroll} aria-live="polite">
    {#each messages as message (message.id)}
      <div class="chat-message {message.role === 'user' ? 'user-message' : 'ai-message'}">
        <div class="message-avatar">{message.role === 'user' ? 'You' : 'AI'}</div>
        <div class="message-content">
          <div class="message-bubble">
            {#each render(message.text) as part, index (index)}
              {#if part.bold}<strong>{part.text}</strong>{:else}<p>{part.text}</p>{/if}
            {/each}
          </div>
          <div class="message-meta">
            <span class="message-timestamp">{message.timestamp}</span>
          </div>
        </div>
      </div>
    {/each}
    {#if thinking && streamingId === null}
      <div class="chat-message ai-message typing-indicator">
        <div class="message-avatar">AI</div>
        <div class="message-content">
          <div class="message-bubble">
            <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"
            ></span>
          </div>
        </div>
      </div>
    {/if}
  </div>

  <button
    class="scroll-to-bottom"
    class:visible={showScrollButton}
    onclick={() => scrollToBottom()}
    title="Scroll to bottom"
    aria-label="Scroll to latest message"
  >
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 14l-6-6h12l-6 6z" />
    </svg>
  </button>

  <div class="chat-composer">
    <div class="chat-suggestions">
      {#each suggestions as suggestion (suggestion)}
        <button class="suggestion-chip" onclick={() => send(suggestion)}>{suggestion}</button>
      {/each}
    </div>

    <div class="chat-input-area">
      <label for="chatInput" class="sr-only">Ask a question</label>
      <input
        type="text"
        id="chatInput"
        placeholder="Ask a question..."
        class="chat-input"
        autocomplete="off"
        bind:value={input}
        onkeydown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <button
        class="chat-send-btn"
        onclick={() => void send()}
        disabled={thinking || input.trim().length === 0}
        title="Send message"
        aria-label="Send message"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M2 10l16-8-8 16-2-8-6-0z" />
        </svg>
      </button>
    </div>
  </div>
</div>
