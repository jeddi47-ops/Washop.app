// Retour immédiat après un scan : bip court + vibration (si le téléphone le permet).
let ctx = null;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// À appeler sur un geste de l'utilisateur (bouton Scanner) : les navigateurs bloquent le son sinon.
export function unlockAudio() {
  audio();
}

function tone(freq, duration, gain = 0.15) {
  const a = audio();
  if (!a) return;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = "square";
  osc.frequency.value = freq;
  g.gain.value = gain;
  osc.connect(g).connect(a.destination);
  const t = a.currentTime;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.start(t);
  osc.stop(t + duration);
}

export function beepOk() {
  tone(1400, 0.09);
  navigator.vibrate?.(60);
}

export function beepError() {
  tone(220, 0.25, 0.12);
  navigator.vibrate?.([80, 60, 80]);
}
