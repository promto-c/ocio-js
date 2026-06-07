import { ACES_CG_V4_CONFIG, createOCIO } from '../../src/index.js';

const width = 960;
const height = 540;

const elements = {
  canvas: document.querySelector('#canvas'),
  status: document.querySelector('#status'),
  version: document.querySelector('#version'),
  source: document.querySelector('#source'),
  display: document.querySelector('#display'),
  view: document.querySelector('#view'),
  exposure: document.querySelector('#exposure'),
  exposureValue: document.querySelector('#exposureValue'),
  gain: document.querySelector('#gain'),
  gainValue: document.querySelector('#gainValue'),
  gamma: document.querySelector('#gamma'),
  gammaValue: document.querySelector('#gammaValue'),
  imageFile: document.querySelector('#imageFile'),
  reset: document.querySelector('#reset')
};

const context = elements.canvas.getContext('2d', { willReadFrequently: true });
let ocio;
let config;
let processor;
let sourcePixels = createSamplePixels(width, height);

function setStatus(message, kind = '') {
  elements.status.textContent = message;
  elements.status.className = `status ${kind}`.trim();
}

function fillSelect(select, values, selected) {
  select.replaceChildren(...values.map((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    option.selected = value === selected;
    return option;
  }));
}

function chooseDefaultSource(colorSpaces) {
  const names = colorSpaces.filter((colorSpace) => !colorSpace.isData).map((colorSpace) => colorSpace.name);
  return names.find((name) => name === 'ACEScg')
    ?? names.find((name) => /linear.*rec\.?709|srgb/i.test(name))
    ?? names[0];
}

function updateViews() {
  const display = elements.display.value;
  const views = config.listViews(display).map((view) => view.name);
  const defaultView = config.getDefaultView(display, elements.source.value) || views[0];
  fillSelect(elements.view, views, views.includes(elements.view.value) ? elements.view.value : defaultView);
}

function rebuildProcessor() {
  processor?.dispose();
  processor = config.createDisplayViewProcessor({
    source: elements.source.value,
    display: elements.display.value,
    view: elements.view.value,
    optimization: 'lossless'
  });
}

function render() {
  try {
    rebuildProcessor();

    const exposure = Number(elements.exposure.value);
    const gain = Number(elements.gain.value);
    const gamma = Number(elements.gamma.value);
    elements.exposureValue.value = exposure.toFixed(2);
    elements.gainValue.value = gain.toFixed(2);
    elements.gammaValue.value = gamma.toFixed(2);

    const working = new Float32Array(sourcePixels);
    const exposureScale = gain * (2 ** exposure);
    for (let index = 0; index < working.length; index += 4) {
      working[index] = Math.max(0, working[index] * exposureScale) ** (1 / gamma);
      working[index + 1] = Math.max(0, working[index + 1] * exposureScale) ** (1 / gamma);
      working[index + 2] = Math.max(0, working[index + 2] * exposureScale) ** (1 / gamma);
    }

    processor.applyRGBAF32(working);

    const output = context.createImageData(width, height);
    for (let index = 0; index < working.length; index += 4) {
      output.data[index] = toByte(working[index]);
      output.data[index + 1] = toByte(working[index + 1]);
      output.data[index + 2] = toByte(working[index + 2]);
      output.data[index + 3] = toByte(working[index + 3]);
    }
    context.putImageData(output, 0, 0);
    setStatus(`${elements.source.value} through ${elements.display.value} / ${elements.view.value}`, 'ok');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
}

function toByte(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(255, Math.max(0, Math.round(value * 255)));
}

function createSamplePixels(w, h) {
  const pixels = new Float32Array(w * h * 4);
  const patches = [
    [0.18, 0.18, 0.18],
    [0.9, 0.08, 0.04],
    [0.04, 0.7, 0.12],
    [0.05, 0.18, 1.2],
    [1.4, 0.78, 0.08],
    [0.62, 0.12, 0.9],
    [2.5, 2.5, 2.5],
    [0.02, 0.02, 0.02]
  ];

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const u = x / (w - 1);
      const v = y / (h - 1);
      const index = (y * w + x) * 4;
      let r = Math.max(0, 1.35 * u);
      let g = Math.max(0, 1.1 * v);
      let b = Math.max(0, 0.25 + 1.5 * (1 - u) * (1 - v));

      const barY = Math.floor((y - h * 0.63) / (h * 0.13));
      const barX = Math.floor((x - w * 0.08) / (w * 0.105));
      if (barY >= 0 && barY < 2 && barX >= 0 && barX < 4) {
        [r, g, b] = patches[barY * 4 + barX];
      }

      const dx = u - 0.72;
      const dy = v - 0.32;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 5.2);
      r += glow * 3.5;
      g += glow * 2.6;
      b += glow * 1.1;

      pixels[index] = r;
      pixels[index + 1] = g;
      pixels[index + 2] = b;
      pixels[index + 3] = 1;
    }
  }

  return pixels;
}

async function loadImageFile(file) {
  const bitmap = await createImageBitmap(file);
  const scratch = new OffscreenCanvas(width, height);
  const scratchContext = scratch.getContext('2d', { willReadFrequently: true });
  scratchContext.fillStyle = 'black';
  scratchContext.fillRect(0, 0, width, height);

  const scale = Math.min(width / bitmap.width, height / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  scratchContext.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);

  const image = scratchContext.getImageData(0, 0, width, height);
  const pixels = new Float32Array(width * height * 4);
  for (let index = 0; index < image.data.length; index += 4) {
    pixels[index] = image.data[index] / 255;
    pixels[index + 1] = image.data[index + 1] / 255;
    pixels[index + 2] = image.data[index + 2] / 255;
    pixels[index + 3] = image.data[index + 3] / 255;
  }
  sourcePixels = pixels;

  const srgb = Array.from(elements.source.options).find((option) => /sRGB Encoded Rec\.709/i.test(option.value));
  if (srgb) {
    elements.source.value = srgb.value;
  }
  updateViews();
  render();
}

async function main() {
  ocio = await createOCIO({
    modulePath: new URL('../../dist/ocio-wasm.js', import.meta.url).href,
    locateFile(path) {
      return path.endsWith('.wasm') ? new URL('../../dist/ocio-wasm.wasm', import.meta.url).href : path;
    }
  });

  elements.version.textContent = `OCIO ${ocio.version}`;
  config = ocio.createBuiltinConfig(ACES_CG_V4_CONFIG);

  const colorSpaces = config.listColorSpaces();
  const sourceNames = colorSpaces.filter((colorSpace) => !colorSpace.isData).map((colorSpace) => colorSpace.name);
  fillSelect(elements.source, sourceNames, chooseDefaultSource(colorSpaces));

  const displays = config.listDisplays();
  fillSelect(elements.display, displays, config.getDefaultDisplay() || displays[0]);
  updateViews();
  render();
}

for (const element of [elements.source, elements.display]) {
  element.addEventListener('change', () => {
    updateViews();
    render();
  });
}

elements.view.addEventListener('change', render);
for (const element of [elements.exposure, elements.gain, elements.gamma]) {
  element.addEventListener('input', render);
}

elements.imageFile.addEventListener('change', () => {
  const file = elements.imageFile.files?.[0];
  if (file) {
    loadImageFile(file).catch((error) => setStatus(error.message, 'error'));
  }
});

elements.reset.addEventListener('click', () => {
  sourcePixels = createSamplePixels(width, height);
  elements.imageFile.value = '';
  render();
});

main().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), 'error');
});
