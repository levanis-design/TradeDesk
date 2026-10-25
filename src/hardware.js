'use strict';
// What this computer can run, and what Ollama already has. Estimates only:
// real memory use depends on the quantization and the context length.

const os = require('os');
const { execFile } = require('child_process');

function detectGpu(exec = execFile) {
  return new Promise((resolve) => {
    exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const gpus = String(stdout).trim().split(/\r?\n/).map((l) => {
          const [name, mb] = l.split(',').map((x) => x.trim());
          const vramGB = Math.round((Number(mb) / 1024) * 10) / 10;
          return name && Number.isFinite(vramGB) ? { name, vramGB } : null;
        }).filter(Boolean);
        resolve(gpus.sort((a, b) => b.vramGB - a.vramGB)[0] || null);
      });
  });
}

async function ollamaStatus(baseUrl, fetchFn = fetch) {
  const base = String(baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const get = async (p) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetchFn(base + p, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  };
  try {
    const [tags, ver] = await Promise.all([get('/api/tags'), get('/api/version').catch(() => ({}))]);
    const models = (tags.models || []).map((m) => ({
      name: m.name,
      sizeGB: Math.round((m.size / 1024 ** 3) * 10) / 10,
      params: m.details && m.details.parameter_size,
      quant: m.details && m.details.quantization_level,
    })).sort((a, b) => a.name.localeCompare(b.name));
    return { running: true, version: ver.version || null, models, url: base };
  } catch (e) {
    return { running: false, models: [], url: base, error: e.name === 'AbortError' ? 'timed out' : e.message };
  }
}

// need = weights + a margin for the context cache. TradingAgents sends long reports,
// so the margin is generous.
function fit(sizeGB, { vramGB, ramGB }) {
  const need = sizeGB * 1.25 + 1.5;
  if (vramGB && need <= vramGB) return { level: 'gpu', label: 'fits in video memory', need };
  if (vramGB && need <= vramGB + ramGB * 0.5) return { level: 'split', label: 'splits between video memory and RAM, slower', need };
  if (need <= ramGB * 0.6) return { level: 'cpu', label: 'runs from RAM only, slow', need };
  return { level: 'no', label: 'too large for this computer', need };
}

// The three local models TradingAgents lists for Ollama, with the sizes it labels them with.
// Download sizes are approximate (about 0.6 GB per billion parameters at 4-bit).
const SUGGESTED = [
  { name: 'qwen3:latest', label: 'Qwen3 (8B)', approxGB: 5.2 },
  { name: 'gpt-oss:latest', label: 'GPT-OSS (20B)', approxGB: 13 },
  { name: 'glm-4.7-flash:latest', label: 'GLM-4.7-Flash (30B)', approxGB: 19 },
];

async function snapshot({ ollamaUrl, fetchFn = fetch, exec = execFile } = {}) {
  const gpu = await detectGpu(exec);
  const ramGB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const ollama = await ollamaStatus(ollamaUrl, fetchFn);
  const mem = { vramGB: gpu ? gpu.vramGB : 0, ramGB };
  const installed = ollama.models.map((m) => ({ ...m, fit: fit(m.sizeGB, mem) }));
  const suggestions = SUGGESTED.map((s) => ({
    ...s,
    installed: ollama.models.some((m) => m.name === s.name),
    fit: fit(s.approxGB, mem),
  }));
  return { gpu, ramGB, cpuCores: os.cpus().length, cpu: (os.cpus()[0] || {}).model || '', ollama, installed, suggestions };
}

module.exports = { detectGpu, ollamaStatus, fit, snapshot, SUGGESTED };
