/* Accompaniment Studio performance worker: keeps MP3 encoding off the UI thread. */
importScripts('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js');

let encoder = null;
let channelCount = 2;
let pendingLeft = new Int16Array(0);
let pendingRight = new Int16Array(0);
const FRAME_SIZE = 1152;

function floatTo16(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i] || 0));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function concat16(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function mergeMp3Parts(parts) {
  if (!parts.length) return new ArrayBuffer(0);
  let length = 0;
  for (const part of parts) length += part.length;
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    merged.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
    offset += part.length;
  }
  return merged.buffer;
}

function encodeAvailable(final = false) {
  const parts = [];
  const usable = final ? pendingLeft.length : Math.floor(pendingLeft.length / FRAME_SIZE) * FRAME_SIZE;
  let offset = 0;
  while (offset < usable) {
    const end = final ? Math.min(usable, offset + FRAME_SIZE) : offset + FRAME_SIZE;
    const left = pendingLeft.subarray(offset, end);
    const mp3 = channelCount === 2
      ? encoder.encodeBuffer(left, pendingRight.subarray(offset, end))
      : encoder.encodeBuffer(left);
    if (mp3.length) parts.push(new Int8Array(mp3));
    offset = end;
  }
  if (offset > 0) {
    pendingLeft = pendingLeft.slice(offset);
    if (channelCount === 2) pendingRight = pendingRight.slice(offset);
  }
  return parts;
}

self.onmessage = (event) => {
  const message = event.data || {};
  const seq = message.seq;
  try {
    if (message.type === 'init') {
      channelCount = message.channels === 1 ? 1 : 2;
      encoder = new lamejs.Mp3Encoder(channelCount, Number(message.sampleRate) || 44100, Number(message.kbps) || 192);
      pendingLeft = new Int16Array(0);
      pendingRight = new Int16Array(0);
      self.postMessage({ type: 'ready', seq });
      return;
    }

    if (!encoder) throw new Error('MP3 encoder is not initialized.');

    if (message.type === 'encode') {
      const leftFloat = new Float32Array(message.left);
      const rightFloat = channelCount === 2 ? new Float32Array(message.right) : null;
      pendingLeft = concat16(pendingLeft, floatTo16(leftFloat));
      if (channelCount === 2) pendingRight = concat16(pendingRight, floatTo16(rightFloat));
      const data = mergeMp3Parts(encodeAvailable(false));
      self.postMessage({ type: 'encoded', seq, data }, [data]);
      return;
    }

    if (message.type === 'finish') {
      const parts = encodeAvailable(true);
      const tail = encoder.flush();
      if (tail.length) parts.push(new Int8Array(tail));
      const data = mergeMp3Parts(parts);
      self.postMessage({ type: 'done', seq, data }, [data]);
      encoder = null;
      pendingLeft = new Int16Array(0);
      pendingRight = new Int16Array(0);
      return;
    }
  } catch (error) {
    self.postMessage({ type: 'error', seq, message: error?.message || String(error) });
  }
};
