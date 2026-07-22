// Composer — steering input pinned under the transcript.
export function mountComposer(root, { onSteer }) {
  root.innerHTML = `
    <div class="composer-note">
      <span class="dot signal"></span>
      conversation first — the kernel codes only after a task contract · steering lands at the next boundary
    </div>
    <div class="composer-box">
      <span class="prompt-sig">▸</span>
      <textarea id="composer-input" rows="1" placeholder="Talk to Vanguard — ask, inspect, or describe the work…"></textarea>
      <button class="composer-send">Send</button>
    </div>
  `;

  const input = root.querySelector('#composer-input');
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    onSteer(text);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });
  root.querySelector('.composer-send').addEventListener('click', submit);
}
