'use strict';
// Setup page, in tabs: Components (what is installed, install what is missing), model and run settings, API keys, this computer.
(function () {
  const { h, $, clear, toast } = U;
  let logBox = null;
  const logLines = [];
  td.onSetupLog((line) => {
    logLines.push(line); if (logLines.length > 400) logLines.shift();
    if (logBox && document.body.contains(logBox)) { logBox.textContent = logLines.join('\n'); logBox.scrollTop = logBox.scrollHeight; }
  });

  let hw = null;
  let progressSink = null;
  td.onComponentProgress((p) => { if (progressSink) progressSink(p); });
  let tabNow = 'components';

  TD.pages.setup = function (el) {
    const s = TD.state.settings;
    const e = TD.state.engine || {};
    const info = TD.state.info || {};

    // ---------------- components (what is installed, what is missing, install from here)
    logBox = h('pre', { class: 'consolebox', 'aria-label': 'Install log', hidden: true }, logLines.join('\n'));
    const compList = h('div', { class: 'complist', 'aria-live': 'polite' });
    const compHead = h('div', { class: 'row center' });
    const compPanel = h('div', { class: 'card compact' }, h('h2', null, 'What TradeDesk needs'),
      h('div', { class: 'sub' }, 'Each item is checked on this computer. Anything missing can be installed from here. Nothing is installed without you pressing a button, and nothing trades or sends your holdings anywhere.'),
      compHead, compList, logBox,
      h('div', { class: 'hint' }, `Engine version is pinned (commit ${(info.pinned || '').slice(0, 7)}). App data folder: ${info.userData || 'unknown'}. Windows may show a permission prompt or a SmartScreen notice during installs.`));
    let comps = null;
    let working = false;
    const rows = {};
    const STATUS = { ok: ['ok', 'Installed'], missing: ['bad', 'Missing'], stopped: ['warn', 'Not running'], blocked: ['warn', 'Waiting'], skip: ['plain', 'Not needed'] };

    const setProgress = (id, p) => {
      const r = rows[id]; if (!r) return;
      r.prog.hidden = false;
      if (typeof p.pct === 'number') { r.bar.style.setProperty('width', p.pct + '%'); r.bar.parentNode.classList.remove('indet'); } else r.bar.parentNode.classList.add('indet');
      r.msg.textContent = p.text || '';
    };
    progressSink = (p) => { if (document.body.contains(compList)) setProgress(p.id, p); };

    async function runOne(c) {
      const r = rows[c.id];
      if (r) { r.btn.disabled = true; r.prog.hidden = false; r.msg.textContent = 'Starting…'; }
      TD.setRunning('installing ' + c.name);
      let res;
      if (c.action === 'engine') { logLines.length = 0; logBox.hidden = false; logBox.textContent = 'Starting…'; res = await td.engineInstall(); }
      else res = await td.componentInstall({ id: c.action === 'start' ? 'start:ollama' : c.action === 'pull' ? c.id : c.id });
      TD.setRunning(null);
      if (!res.ok) { toast(`${c.name}: ${res.error}`.slice(0, 220), 'error'); if (r) { r.msg.textContent = res.error; r.prog.hidden = false; } return false; }
      return true;
    }
    async function after() { await TD.refreshStatus(); await loadComps(); }

    function paintComps() {
      clear(compList); clear(compHead);
      const items = comps.items;
      const need = items.filter((c) => c.required && c.status !== 'ok' && c.status !== 'skip');
      compHead.append(
        h('span', { class: `badge ${comps.ready ? 'ok' : 'warn'}` }, comps.ready ? 'Everything required is installed' : `${need.length} required item${need.length === 1 ? '' : 's'} missing`),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small', 'data-needs-idle': '', onclick: after }, 'Check again'),
        comps.ready ? null : h('button', { class: 'btn primary small', id: 'installAll', 'data-needs-idle': '', onclick: installAll }, 'Install everything missing'));
      items.forEach((c) => {
        const [cls, label] = STATUS[c.status] || ['plain', c.status];
        const btn = c.action ? (c.action === 'link'
          ? h('button', { class: 'btn small', onclick: () => td.openLink({ url: c.link }) }, c.actionLabel)
          : h('button', { class: 'btn small primary', 'data-needs-idle': '', dataset: { comp: c.id }, onclick: async () => { working = true; const ok = await runOne(c); working = false; if (ok) toast(`${c.name} done.`, 'ok'); await after(); } }, c.actionLabel)) : null;
        const bar = h('i'); const msg = h('span', { class: 'hint' });
        const prog = h('div', { class: 'cprog', hidden: true }, h('div', { class: 'ctrack' }, bar), msg);
        rows[c.id] = { btn, bar, msg, prog };
        compList.append(h('div', { class: `comp ${c.status}`, dataset: { comp: c.id } },
          h('div', { class: 'cmain' },
            h('div', { class: 'ctitle' }, h('b', null, c.name), c.required ? null : h('span', { class: 'badge plain' }, 'optional'), h('span', { class: `badge ${cls}` }, label)),
            h('div', { class: 'cwhat' }, c.what, ' ', h('span', { class: 'hint' }, c.use)),
            h('div', { class: 'hint' }, c.detail),
            h('div', { class: 'hint' }, `Size: ${c.size}. From: ${c.source}.`),
            prog),
          h('div', { class: 'cact' }, btn)));
      });
    }
    async function installAll() {
      if (working) return; working = true;
      const all = $('#installAll'); if (all) all.disabled = true;
      let guard = 0;
      while (guard++ < 8) {
        const st = await td.components();
        if (!st.ok) { toast(st.error, 'error'); break; }
        comps = st; paintComps();
        const next = st.items.find((c) => c.required && c.status !== 'ok' && c.status !== 'skip' && ['install', 'start', 'pull', 'engine'].includes(c.action));
        if (!next) break;
        if (!(await runOne(next))) break;
      }
      working = false;
      await after();
    }
    async function loadComps() {
      const st = await td.components();
      if (!document.body.contains(compList)) return;
      if (!st.ok) { clear(compList).append(h('div', { class: 'callout bad' }, st.error)); return; }
      comps = st; paintComps();
    }
    compList.append(h('div', { class: 'hint' }, 'Checking this computer…'));
    loadComps();

    // ---------------- model
    const f = {};
    const field = (label, node, hint) => h('div', { class: 'field' }, h('label', null, label), node, hint ? h('div', { class: 'hint' }, hint) : null);
    f.provider = h('select', { onchange: () => { settingsChanged(); } }, [['ollama', 'Ollama (local, free)'], ['openai_compatible', 'Local server: LM Studio, llama.cpp, vLLM'], ['anthropic', 'Anthropic API (paid, cloud)'], ['openai', 'OpenAI API (paid, cloud)']]
      .map(([v, l]) => h('option', { value: v, selected: s.provider === v }, l)));
    f.ollamaUrl = h('input', { type: 'text', value: s.ollamaUrl });
    f.backendUrl = h('input', { type: 'text', value: s.backendUrl, placeholder: 'http://localhost:1234/v1' });
    f.quick = h('input', { type: 'text', value: s.quickModel, list: 'models' });
    f.deep = h('input', { type: 'text', value: s.deepModel, list: 'models' });
    const datalist = h('datalist', { id: 'models' });
    f.debate = h('input', { type: 'number', min: 1, max: 3, value: s.debateRounds, style: { width: '80px' } });
    f.risk = h('input', { type: 'number', min: 1, max: 3, value: s.riskRounds, style: { width: '80px' } });
    f.lang = h('input', { type: 'text', value: s.language, style: { width: '140px' } });
    f.temp = h('input', { type: 'number', step: '0.1', min: 0, max: 2, value: s.temperature, placeholder: 'default', style: { width: '90px' } });
    f.bench = h('input', { type: 'text', value: s.benchmark, class: 'ticker', style: { width: '100px' } });
    f.cash = h('input', { type: 'number', step: 'any', min: 0, value: s.cashOverride, placeholder: 'use holdings file', style: { width: '160px' } });
    f.sec = h('input', { type: 'text', id: 'secContact', value: s.secUserAgent || '', placeholder: 'Your Name you@example.com', style: { width: '300px' } });
    f.python = h('input', { type: 'text', value: s.pythonPath, placeholder: 'leave blank to auto-detect' });
    const analysts = h('div', { class: 'row center' }, [['market', 'Market'], ['social', 'Sentiment'], ['news', 'News'], ['fundamentals', 'Fundamentals']].map(([v, l]) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', dataset: { analyst: v }, checked: s.analysts.includes(v) }), l)));
    const costNote = h('div', { class: 'callout warn', hidden: true }, 'Cloud models are billed per use. One analysis makes dozens of model calls with long prompts, and a watchlist or backtest multiplies that. Check your provider\'s pricing and set a spending limit with them before running batches.');
    const checks = h('div', { class: 'checks' });

    const read = () => ({
      provider: f.provider.value, ollamaUrl: f.ollamaUrl.value, backendUrl: f.backendUrl.value, quickModel: f.quick.value, deepModel: f.deep.value,
      debateRounds: f.debate.value, riskRounds: f.risk.value, language: f.lang.value, temperature: f.temp.value, benchmark: f.bench.value,
      cashOverride: f.cash.value, secUserAgent: f.sec.value, pythonPath: f.python.value, analysts: U.$$('[data-analyst]', el).filter((c) => c.checked).map((c) => c.dataset.analyst),
    });
    const save = async () => {
      const r = await td.setSettings(read());
      if (!r.ok) { toast(r.error, 'error'); return false; }
      TD.state.settings = r.settings; TD.paintChips(); toast('Settings saved.', 'ok'); return true;
    };
    const check = h('button', { class: 'btn', 'data-needs-idle': '', onclick: async () => {
      if (!(await save())) return;
      const nr = TD.notReady(); if (nr) return toast(nr, 'error');
      clear(checks).append(h('div', { class: 'hint' }, 'Testing the model. The first call can be slow while it loads…'));
      check.disabled = true; TD.setRunning('model check');
      const r = await td.modelCheck();
      TD.setRunning(null); check.disabled = false;
      clear(checks);
      if (r.ok && r.passed) { await TD.refreshStatus(); }
      if (!r.ok) return checks.append(h('div', { class: 'callout bad' }, r.canceled ? 'Cancelled.' : r.error), r.stderr ? h('pre', { class: 'consolebox' }, r.stderr) : null);
      r.checks.forEach((c) => checks.append(h('div', { class: 'checkrow' }, h('span', { class: `badge ${c.ok ? 'ok' : 'bad'}` }, c.ok ? 'Pass' : 'Fail'), h('span', { class: 'name' }, c.name), h('span', { class: 'hint' }, c.detail))));
      checks.append(r.passed
        ? h('div', { class: 'callout' }, 'This model can answer, call tools and return structured output, which the agents need. That does not say how good its analysis is. Run the Backtest before you rely on it.')
        : h('div', { class: 'callout bad' }, 'This model failed a basic requirement, so full runs will probably fail or produce poor output. Pick another model, preferably one that lists tool support.'));
    } }, 'Save and check this model');

    const modelCard = h('div', { class: 'card compact' }, h('h2', null, 'Model and run settings'),
      h('div', { class: 'sub' }, 'Local models keep everything on this computer and cost nothing per run. The agents need a model that can call tools and return structured output.'),
      h('div', { class: 'row top' }, field('Provider', f.provider), field('Ollama address', f.ollamaUrl, 'Default is this computer.'), field('Server address (local server only)', f.backendUrl)),
      h('div', { class: 'row top', style: { marginTop: '10px' } }, field('Quick model (analysts, researchers, trader)', f.quick), field('Deep model (managers)', f.deep, 'Can match the quick model.'), datalist),
      h('div', { class: 'row top', style: { marginTop: '10px' } }, field('Debate rounds', f.debate, 'More rounds, slower.'), field('Risk rounds', f.risk), field('Output language', f.lang), field('Temperature', f.temp), field('Benchmark', f.bench, 'For scoring.')),
      h('div', { style: { marginTop: '10px' } }, h('div', { class: 'lbl' }, 'Analysts to include (fewer is faster)'), analysts),
      h('div', { class: 'row top', style: { marginTop: '10px' } }, field('Cash override (optional)', f.cash, 'Replaces cash from the holdings file.'), field('Python path (optional)', f.python)),
      h('div', { class: 'row top', style: { marginTop: '10px' } }, field('SEC contact (for Research)', f.sec, 'Your name and email. The SEC requires it on every request for filings and results. It is sent only to the SEC and is not needed for anything else.')),
      costNote,
      h('div', { class: 'row center', style: { marginTop: '14px' } }, h('button', { class: 'btn primary', onclick: save }, 'Save settings'), check),
      checks);


    // ---------------- keys
    const keysCard = h('div', { class: 'card compact', id: 'keysCard' }, h('h2', null, 'API keys (optional)'),
      h('div', { class: 'sub' }, `Stored encrypted by Windows${info.secureStorage ? '' : ' (not available on this computer, so keys cannot be saved)'}. Only needed for cloud providers or optional data sources. Keys are never shown again after saving.`));
    const keyRow = (name, label) => {
      const inp = h('input', { type: 'password', placeholder: TD.state.secrets[name] ? 'saved (enter a new one to replace)' : 'not set', autocomplete: 'off', style: { width: '320px' } });
      return h('div', { class: 'row center', style: { marginBottom: '8px' } }, h('div', { class: 'field' }, h('label', null, label), inp),
        h('button', { class: 'btn small', onclick: async () => { const r = await td.setSecret({ name, value: inp.value }); if (!r.ok) return toast(r.error, 'error'); TD.state.secrets = r.secrets; inp.value = ''; inp.placeholder = r.secrets[name] ? 'saved (enter a new one to replace)' : 'not set'; toast('Saved.', 'ok'); } }, 'Save'),
        h('button', { class: 'btn small', onclick: async () => { const r = await td.setSecret({ name, value: '' }); if (r.ok) { TD.state.secrets = r.secrets; inp.placeholder = 'not set'; toast('Removed.', 'ok'); } } }, 'Remove'));
    };
    keysCard.append(keyRow('ANTHROPIC_API_KEY', 'Anthropic API key (cloud provider)'), keyRow('OPENAI_API_KEY', 'OpenAI API key (cloud provider)'),
      keyRow('FRED_API_KEY', 'FRED key (free, macro data)'), keyRow('ALPHA_VANTAGE_API_KEY', 'Alpha Vantage key (optional data source)'));


    // ---------------- hardware
    const hwCard = h('div', { class: 'card compact' }, h('h2', null, 'This computer and models'), h('div', { id: 'hwbody', class: 'hint' }, 'Looking…'));

    const panels = { components: compPanel, model: modelCard, keys: keysCard, computer: hwCard };
    const tabsDef = [{ id: 'components', label: 'Components' }, { id: 'model', label: 'Model and run settings' }, { id: 'keys', label: 'API keys' }, { id: 'computer', label: 'This computer' }];
    const showTab = (id) => { Object.entries(panels).forEach(([k, n]) => { n.hidden = k !== id; }); tabNow = id; };
    const tb = TD.tabs(tabsDef, tabNow, showTab);
    el.append(tb.bar, compPanel, modelCard, keysCard, hwCard);
    showTab(tabNow);

    function settingsChanged() {
      const cloud = f.provider.value === 'anthropic' || f.provider.value === 'openai';
      costNote.hidden = !cloud;
    }
    settingsChanged();

    (async () => {
      hw = await td.hardware();
      const body = $('#hwbody');
      if (!body || !hw.ok) return;
      clear(body);
      body.className = '';
      const fitBadge = (fit) => h('span', { class: `badge ${fit.level === 'gpu' ? 'ok' : fit.level === 'no' ? 'bad' : 'warn'}` }, fit.label);
      body.append(h('div', { class: 'meta' },
        h('span', null, 'Video card: ', h('b', null, hw.gpu ? `${hw.gpu.name}, ${hw.gpu.vramGB} GB` : 'no NVIDIA card detected')),
        h('span', null, 'Memory: ', h('b', null, `${hw.ramGB} GB`)), h('span', null, 'Processor: ', h('b', null, `${hw.cpuCores} threads`)),
        h('span', null, 'Ollama: ', h('b', null, hw.ollama.running ? `running${hw.ollama.version ? ' v' + hw.ollama.version : ''}` : 'not reachable'))));
      if (!hw.ollama.running) body.append(h('div', { class: 'callout warn' }, 'Ollama is not running at ', h('code', null, hw.ollama.url), '. Install it from ollama.com and start it, then reopen this page.', ' ',
        h('button', { class: 'btn link', onclick: () => td.openLink({ url: 'https://ollama.com/download' }) }, 'Open ollama.com')));
      datalist.append(...hw.installed.map((m) => h('option', { value: m.name })));
      if (hw.installed.length) {
        body.append(h('h4', { style: { margin: '10px 0 6px' } }, 'Models you have installed'));
        body.append(h('div', { class: 'tablewrap' }, h('table', { class: 'list' }, h('thead', null, h('tr', null, ['Model', 'Size', 'Fit estimate', ''].map((t) => h('th', null, t)))),
          h('tbody', null, hw.installed.map((m) => h('tr', null, h('td', null, h('b', null, m.name)), h('td', null, `${m.sizeGB} GB${m.params ? ' · ' + m.params : ''}`), h('td', null, fitBadge(m.fit)),
            h('td', { class: 'num' }, h('button', { class: 'btn small', onclick: () => { f.quick.value = m.name; f.deep.value = m.name; toast(`Selected ${m.name}. Press Save settings.`); } }, 'Use'))))))));
      }
      const dl = (m) => {
        if (!hw.ollama.running) return h('span', { class: 'hint' }, 'Start Ollama first (Components tab)');
        const msg = h('span', { class: 'hint' });
        const b = h('button', { class: 'btn small', 'data-needs-idle': '', onclick: async () => {
          b.disabled = true; msg.textContent = 'Starting…';
          const off = td.onComponentProgress((p) => { if (p.id === 'model:' + m.name) msg.textContent = p.pct != null ? `${p.pct}%` : (p.text || ''); });
          TD.setRunning('downloading ' + m.name);
          const r = await td.componentInstall({ id: 'model:' + m.name });
          TD.setRunning(null); if (typeof off === 'function') off();
          if (!r.ok) { b.disabled = false; msg.textContent = ''; return toast(r.error, 'error'); }
          toast(`${m.name} downloaded.`, 'ok'); TD.go('setup');
        } }, 'Download');
        return h('span', { class: 'row center' }, b, msg);
      };
      body.append(h('h4', { style: { margin: '14px 0 6px' } }, 'Models TradingAgents suggests for Ollama'));
      body.append(h('div', { class: 'tablewrap' }, h('table', { class: 'list' }, h('thead', null, h('tr', null, ['Model', 'About', 'Fit estimate', 'To install'].map((t) => h('th', null, t)))),
        h('tbody', null, hw.suggestions.map((m) => h('tr', null, h('td', null, h('b', null, m.label), h('div', { class: 'hint' }, m.name)), h('td', null, `${m.approxGB} GB`), h('td', null, fitBadge(m.fit)),
          h('td', null, m.installed ? h('span', { class: 'badge ok' }, 'installed') : dl(m))))))));
      body.append(h('div', { class: 'hint', style: { marginTop: '10px' } },
        'Fit is an estimate from file size plus room for the context. Bigger models give better reasoning and run slower. The agents send long reports to the model, so if answers look cut off or ignore earlier material, raise Ollama\'s context length (check the Ollama documentation for your version) and run the model check again.'));
    })();
  };
})();
