'use strict';
// Image generation with Google's Gemini image models on Vertex AI, plus resizing with sharp.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('./config');

// USD per image by size. https://cloud.google.com/vertex-ai/generative-ai/pricing
const IMAGE_PRICES = {
  'gemini-3.1-flash-image': { '1K': 0.067, '2K': 0.101, '4K': 0.15 },
  'gemini-nano-banana-2.1': { '1K': 0.034, '2K': 0.05, '4K': 0.113 },
  'gemini-3-pro-image': { '1K': 0.134, '2K': 0.134, '4K': 0.24 },
};
const imagePrice = () => IMAGE_PRICES[config.imageModel]?.[config.imageSize] ?? 0.15;

const DESIGN_DIR = path.join(config.dataDir, 'designs');
fs.mkdirSync(DESIGN_DIR, { recursive: true });

// ---- Google auth: the VM's own service account, via the metadata server ----
let cachedToken = null;
let cachedProject = null;

async function metadata(p) {
  const res = await fetch(`${config.gcpMetadataUrl}/computeMetadata/v1/${p}`, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!res.ok) throw new Error(`Google metadata server said ${res.status}`);
  return res;
}

async function googleToken() {
  if (process.env.GCP_ACCESS_TOKEN) return process.env.GCP_ACCESS_TOKEN;
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  let data;
  try {
    data = await (await metadata('instance/service-accounts/default/token')).json();
  } catch (err) {
    throw new Error(`Could not get a Google login from the VM (${err.message}). Is this running on the Google Cloud VM?`);
  }
  cachedToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function googleProject() {
  if (config.gcpProject) return config.gcpProject;
  if (!cachedProject) cachedProject = (await (await metadata('project/project-id')).text()).trim();
  return cachedProject;
}

// Turns Google's error replies into something actionable.
function explainGoogleError(status, message) {
  if (status === 403 && /scope/i.test(message))
    return "The VM isn't allowed to use Google's AI APIs yet. Change its access scopes to \"Allow full access to all Cloud APIs\" (see the README).";
  if (status === 403 && /(has not been used|disabled|not enabled)/i.test(message))
    return 'The Vertex AI API is switched off for this project. Enable it in the Google Cloud console (see the README).';
  if (status === 404) return `Google doesn't recognise the image model "${config.imageModel}". Try another IMAGE_MODEL in .env.`;
  if (status === 429) return 'Google is rate-limiting image requests. Wait a minute and try again.';
  return `Google image API error ${status}: ${message}`;
}

// Generates one image. Returns { buffer, mimeType, costUsd, note }.
async function generateImage(prompt, signal) {
  const [token, project] = await Promise.all([googleToken(), googleProject()]);
  const url = `${config.googleApiBase}/v1/projects/${project}/locations/global/publishers/google/models/${config.imageModel}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: config.imageAspect, imageSize: config.imageSize },
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(explainGoogleError(res.status, data?.error?.message || res.statusText));

  const parts = data.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData?.data);
  const note = parts.filter((p) => p.text).map((p) => p.text).join(' ').trim();
  if (!img) {
    const reason = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'no image returned';
    const err = new Error(`No image came back (${reason})${note ? `: ${note.slice(0, 200)}` : ''}`);
    err.noImage = true;
    throw err;
  }
  return {
    buffer: Buffer.from(img.inlineData.data, 'base64'),
    mimeType: img.inlineData.mimeType || 'image/png',
    costUsd: imagePrice(),
    note,
  };
}

// Saves the original and makes: a thumbnail for the dashboard, a downsized view for the judge,
// and a full-resolution centre crop so the judge can check fine detail at print size.
async function saveImage(designId, attempt, buffer) {
  const base = path.join(DESIGN_DIR, `${designId}-${attempt}`);
  const original = sharp(buffer, { failOn: 'none' });
  const meta = await original.metadata();
  await sharp(buffer).png().toFile(`${base}.png`);
  await sharp(buffer).resize({ width: 600, height: 600, fit: 'inside' }).webp({ quality: 80 }).toFile(`${base}-thumb.webp`);
  const preview = await sharp(buffer)
    .resize({ width: 1400, height: 1400, fit: 'inside' })
    .jpeg({ quality: 85 })
    .toBuffer();
  await fs.promises.writeFile(`${base}-preview.jpg`, preview);
  const cropSize = Math.min(1024, meta.width, meta.height);
  const crop = await sharp(buffer)
    .extract({
      left: Math.floor((meta.width - cropSize) / 2),
      top: Math.floor((meta.height - cropSize) / 2),
      width: cropSize,
      height: cropSize,
    })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { width: meta.width, height: meta.height, preview, crop };
}

function imagePath(designId, attempt, variant) {
  const suffix = { full: '.png', thumb: '-thumb.webp', preview: '-preview.jpg' }[variant];
  if (!suffix) return null;
  return path.join(DESIGN_DIR, `${designId}-${attempt}${suffix}`);
}

module.exports = { generateImage, saveImage, imagePath, imagePrice };
