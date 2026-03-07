const promptEl = document.getElementById('prompt');
const generateBtn = document.getElementById('generateBtn');
const statusEl = document.getElementById('status');
const charCountEl = document.getElementById('charCount');

const resultCard = document.getElementById('resultCard');
const affirmationEl = document.getElementById('affirmation');
const copyBtn = document.getElementById('copyBtn');
const newBtn = document.getElementById('newBtn');

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', Boolean(isError));
}

function updateCharCount() {
  const len = (promptEl.value || '').length;
  charCountEl.textContent = `${len}/500`;
}

async function generate() {
  const prompt = (promptEl.value || '').trim();
  resultCard.hidden = true;
  affirmationEl.textContent = '';

  if (!prompt) {
    setStatus('Please describe your day (a sentence or two is enough).', true);
    return;
  }
  if (prompt.length > 500) {
    setStatus('Please keep it under 500 characters.', true);
    return;
  }

  setStatus('Generating…', false);
  generateBtn.disabled = true;

  try {
    // Use the primary API route as specified in the approved plan.
    const res = await fetch('api/affirmation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });

    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : null;

    if (!res.ok) {
      const code = data && data.error ? data.error : 'request_failed';
      if (res.status === 429) {
        setStatus('You’re generating too fast. Please wait a bit and try again.', true);
      } else if (code === 'prompt_required') {
        setStatus('Please add a short description of your day.', true);
      } else if (code === 'prompt_too_long') {
        setStatus('Please keep it under 500 characters.', true);
      } else if (code === 'server_not_configured') {
        setStatus('Server is not configured yet (missing API key).', true);
      } else {
        setStatus('Something went wrong generating your affirmation. Please try again.', true);
      }
      return;
    }

    const affirmation = (data && data.affirmation) ? String(data.affirmation).trim() : '';
    if (!affirmation) {
      setStatus('No affirmation returned. Please try again.', true);
      return;
    }

    setStatus('', false);
    affirmationEl.textContent = affirmation;
    resultCard.hidden = false;
    resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    setStatus('Network error. Please try again.', true);
  } finally {
    generateBtn.disabled = false;
  }
}

copyBtn.addEventListener('click', async () => {
  const text = affirmationEl.textContent || '';
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    setStatus('Copied to clipboard.', false);
    setTimeout(() => setStatus('', false), 1200);
  } catch (e) {
    setStatus('Copy failed. You can select and copy manually.', true);
  }
});

newBtn.addEventListener('click', () => {
  resultCard.hidden = true;
  affirmationEl.textContent = '';
  setStatus('', false);
  promptEl.focus();
});

generateBtn.addEventListener('click', generate);

promptEl.addEventListener('input', updateCharCount);

promptEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    generate();
  }
});

updateCharCount();
