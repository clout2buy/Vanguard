// Static UI metadata for the LIVE build.
// Providers and models come from the bridge (/api/providers → the kernel's
// own catalog). What lives here is what the kernel does not expose: the
// reasoning-effort scheme each provider's models respond to, rendered as a
// per-provider preference the UI keeps.

export const REASONING_SCHEMES = {
  kimi: {
    scheme: 'thinking trace',
    levels: [
      { id: 'off', label: 'off', cost: 'fastest', desc: '<b>Off.</b> Direct answers, no deliberation pass — conversation and read-only inspection.' },
      { id: 'on', label: 'on', cost: 'deeper', desc: '<b>On.</b> A thinking pass before acting. Recommended once the task contract involves mutations.' },
    ],
  },
  anthropic: {
    scheme: 'adaptive thinking',
    levels: [
      { id: 'low', label: 'low', cost: 'fastest', desc: '<b>Low.</b> Near-instant replies with brief interleaved checks.' },
      { id: 'medium', label: 'medium', cost: 'balanced', desc: '<b>Medium.</b> Deliberates before mutating; the daily-driver tier.' },
      { id: 'high', label: 'high', cost: 'slow', desc: '<b>High.</b> Plans against the verifier quorum before acting.' },
      { id: 'max', label: 'max', cost: 'slowest', desc: '<b>Max.</b> Full deliberation ceiling for certification-grade runs.' },
    ],
  },
  openai: {
    scheme: 'reasoning effort',
    levels: [
      { id: 'minimal', label: 'minimal', cost: 'fastest', desc: '<b>Minimal.</b> Deliberation nearly disabled — answers first.' },
      { id: 'low', label: 'low', cost: 'fast', desc: '<b>Low.</b> Light reasoning pass for mechanical edits.' },
      { id: 'medium', label: 'medium', cost: 'balanced', desc: '<b>Medium.</b> Standard effort.' },
      { id: 'high', label: 'high', cost: 'slow', desc: '<b>High.</b> Extended internal traces before acting.' },
      { id: 'xhigh', label: 'xhigh', cost: 'slowest', desc: '<b>Extra high.</b> Maximum effort; the turn budget still applies.' },
    ],
  },
  deepseek: {
    scheme: 'reasoner mode',
    levels: [
      { id: 'off', label: 'off', cost: 'fastest', desc: '<b>Off.</b> Chat mode — direct completion, verifier carries correctness.' },
      { id: 'on', label: 'on', cost: 'slow', desc: '<b>On.</b> Reasoner mode: long chain-of-thought before the answer, journaled as a trace.' },
    ],
  },
  ollama: {
    scheme: 'think toggle',
    levels: [
      { id: 'off', label: 'off', cost: 'fastest', desc: '<b>Off.</b> Direct completion, lowest latency.' },
      { id: 'on', label: 'on', cost: 'varies', desc: '<b>On.</b> The model emits a thinking trace; depth is model-defined.' },
    ],
  },
};

export const DEFAULT_SETTINGS = {
  provider: 'kimi',
  model: 'kimi-for-coding',
  workspace: '',
  levels: { kimi: 'on', anthropic: 'high', openai: 'high', deepseek: 'on', ollama: 'on' },
  profile: 'workspace',
  maxTurns: 240,
};
