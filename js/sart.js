(() => {
  // ------------------------- Config & State -------------------------
  const ui = {
    intro: byId('screen-intro'),
    stage: byId('screen-stage'),
    survey: byId('screen-survey'),
    finish: byId('screen-finish'),
    display: byId('display'),
    bar: byId('bar'),
    stageLabel: byId('stage-label'),
    risk: byId('risk'),
    trials: byId('trial-count'),
    timeLeft: byId('time-left'),
    surveyQs: byId('survey-qs'),
    summary: byId('summary')
  };
  const cfg = () => ({
    baselineMin: toNum('cfg-baseline'),
    blockMin: toNum('cfg-blockMin'),
    breakMin: toNum('cfg-break'),
    isiMs: toNum('cfg-isi'),
    stimMs: toNum('cfg-stim'),
    nogoFreq: toNum('cfg-nogo'), // interpreted as frequency of showing 3 (target)
  });

  const STATE = {
    sessionId: null,
    phase: 'idle',
    trials: [],
    surveys: [],
    phasesMeta: {},
    blockATrials: 0,
    blockBTrials: 0,
    running: false,
    tEnd: 0,
    currentTrial: null,
    riskScore: 0,
    rtWindow: [],
    selfReportActive: false,
  };

  function byId(id){return document.getElementById(id)}
  function toNum(id){return parseFloat(byId(id).value)}
  function now(){return performance.now()}
  function fmtTime(ms){
    const s=Math.max(0,Math.ceil(ms/1000));
    const m=Math.floor(s/60);
    const r=s%60;
    return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
  }

  function setScreen(which){
    ui.intro.style.display = which==='intro'?'block':'none';
    ui.stage.style.display = which==='stage'?'block':'none';
    ui.survey.style.display = which==='survey'?'block':'none';
    ui.finish.style.display = which==='finish'?'block':'none';
  }

  function newSession(){
    STATE.sessionId = `NB_${new Date().toISOString().replace(/[:.]/g,'-')}`;
    STATE.phase = 'idle';
    STATE.trials = [];
    STATE.surveys = [];
    STATE.phasesMeta = {};
    STATE.blockATrials = 0;
    STATE.blockBTrials = 0;
    STATE.rtWindow = [];
    STATE.riskScore = 0;
    setScreen('intro');
  }

  // ------------------------- Trial Engine -------------------------
  const DIGITS = [0,1,2,3,4,5,6,7,8,9];

  // Keep the control name but treat it as the probability of showing 3 (the target)
  function pickStim(targetFreq){
    if (Math.random() < targetFreq) return 3;
    const choices = DIGITS.filter(d => d !== 3);
    return choices[Math.floor(Math.random()*choices.length)];
  }

  async function runStage(kind, minutes, withFeedback){
    STATE.phase = kind;
    STATE.running = true;
    STATE.selfReportActive = false;
    ui.stageLabel.textContent = labelFor(kind);
    setScreen('stage');

    const durationMs = minutes*60*1000;
    const tStart = now();
    STATE.tEnd = tStart + durationMs;

    if(kind === 'baseline'){
      ui.display.textContent = '+';
      while(now() < STATE.tEnd && STATE.running){
        const left = STATE.tEnd - now();
        ui.timeLeft.textContent = fmtTime(left);
        ui.bar.style.width = `${100*(1 - left/durationMs)}%`;
        await sleep(200);
      }
      return;
    }

    const { isiMs, stimMs, nogoFreq } = cfg(); // nogoFreq used as target freq for "3"
    let tNext = now();

    while(now() < STATE.tEnd && STATE.running){
      const digit = pickStim(nogoFreq);
      const isTarget = digit === 3; // press ONLY on 3

      const tStimOn = Math.max(now(), tNext);
      const deadline = tStimOn + stimMs + isiMs;

      let responded = false;
      let rtMs = null;
      let keyDown = null;
      let correct = null;
      let lapse = false;
      let vibrated = false;
      let riskAt = null;

      ui.display.textContent = String(digit);
      riskAt = computeRisk();
      if(withFeedback && riskAt > 0.65){
        vibrated = tryVibrate(60);
      }

      while(now() < deadline && STATE.running){
        const left = STATE.tEnd - now();
        ui.timeLeft.textContent = fmtTime(left);
        ui.bar.style.width = `${100*(1 - left/durationMs)}%`;
        await sleep(8);
        if(STATE.currentTrial && STATE.currentTrial._resolved) break;
      }

      if(now() > tStimOn + stimMs){ ui.display.textContent = '·'; }

      if(!responded && STATE.currentTrial){
        responded = STATE.currentTrial.responded;
        rtMs = STATE.currentTrial.rtMs;
        keyDown = STATE.currentTrial.key;
      }

      // ---------- Corrected conditional block (press only on 3) ----------
      if (isTarget) { // must press
        correct = responded;
        const slowCut = Math.max(600, 2*median(STATE.rtWindow) || 600);
        lapse = !responded || (rtMs !== null && rtMs > slowCut); // miss or too slow
      } else {        // must withhold
        correct = !responded;
        lapse = responded; // false alarm
      }
      if(STATE.selfReportActive) lapse = true;
      // -------------------------------------------------------------------

      const trial = {
        sessionId: STATE.sessionId,
        phase: kind,
        tStimOn: tsISO(),
        digit,
        isTarget,             // <— note name change
        responded, keyDown, rtMs,
        correct, lapse,
        riskScore: riskAt,
        selfReportActive: STATE.selfReportActive,
        vibrated,
      };
      STATE.trials.push(trial);
      ui.trials.textContent = STATE.trials.length;

      if(kind==='blockA') STATE.blockATrials++;
      else if(kind==='blockB') STATE.blockBTrials++;

      if(rtMs!=null){
        STATE.rtWindow.push(rtMs);
        if(STATE.rtWindow.length>25) STATE.rtWindow.shift();
      }

      STATE.currentTrial = null;
      tNext = deadline;
    }
  }

  function labelFor(kind){
    return {
      'baseline':'Baseline (fixation)',
      'blockA':'Block A — no feedback',
      'break':'Break',
      'blockB':'Block B — feedback',
    }[kind] || kind;
  }

  function computeRisk(){
    const m = median(STATE.rtWindow) || 350;
    const mad = medianAbsoluteDeviation(STATE.rtWindow) || 40;
    let risk = 0.2
      + clamp((m-350)/300, 0, 0.6)
      + clamp((mad-60)/200, 0, 0.4)
      + (Math.random()*0.05);
    if(window.__NB_physioBoost){
      risk += clamp(window.__NB_physioBoost, -0.2, 0.8);
      window.__NB_physioBoost *= 0.9;
    }
    STATE.riskScore = clamp(risk,0,1);
    ui.risk.textContent = STATE.riskScore.toFixed(2);
    return STATE.riskScore;
  }

  function tryVibrate(ms){
    if(navigator.vibrate){ navigator.vibrate(ms); return true; }
    return false;
  }

  // ------------------------- Surveys -------------------------
  const SURVEY_TEMPLATE = [
    { id:'mental_demand', label:'Mental demand', scale: [1,7] },
    { id:'effort', label:'Effort required', scale: [1,7] },
    { id:'focus', label:'How focused were you?', scale: [1,7] },
    { id:'mind_wandering', label:'Mind-wandering frequency', scale: [1,7] },
    { id:'fatigue', label:'Fatigue right now', scale: [1,7] },
  ];

  function renderSurvey(phase){
    setScreen('survey');
    ui.surveyQs.innerHTML = '';
    SURVEY_TEMPLATE.forEach(q => {
      const wrap = document.createElement('div');
      wrap.className = 'survey-q';
      wrap.innerHTML = `<label>${q.label}</label>${renderLikert(q.id)}`;
      ui.surveyQs.appendChild(wrap);
    });
    ui.surveyQs.dataset.phase = phase;
  }

  function renderLikert(id){
    const opts = [];
    for(let i=1;i<=7;i++){
      opts.push(`<label style="display:inline-flex;align-items:center;gap:6px;margin-right:10px"><input type="radio" name="${id}" value="${i}" required>${i}</label>`)
    }
    return `<div>${opts.join('')}</div>`;
  }

  function collectSurvey(){
    const phase = ui.surveyQs.dataset.phase;
    const entries = {};
    let complete = true;
    for(const q of SURVEY_TEMPLATE){
      const sel = document.querySelector(`input[name="${q.id}"]:checked`);
      if(!sel){ complete=false; break; }
      entries[q.id] = Number(sel.value);
    }
    if(!complete){ alert('Please answer all items.'); return false; }
    STATE.surveys.push({ sessionId: STATE.sessionId, phase, at: tsISO(), ...entries });
    return true;
  }

  // ------------------------- Flow Controller -------------------------
  async function runSession(){
    const c = cfg();
    STATE.phasesMeta.config = c;

    await runStage('baseline', c.baselineMin, false);
    STATE.running = false;

    await runStage('blockA', c.blockMin, false);
    STATE.running = false;
    renderSurvey('after_blockA');
    await waitForSurvey();

    await runBreak(c.breakMin);

    await runStage('blockB', c.blockMin, true);
    STATE.running = false;
    renderSurvey('after_blockB');
    await waitForSurvey();

    finish();
  }

  // Skip-able break (creates button if missing)
  function runBreak(minutes){
    STATE.phase = 'break';
    setScreen('stage');
    ui.stageLabel.textContent = labelFor('break');

    const durationMs = minutes*60*1000;
    const tStart = now();
    STATE.tEnd = tStart + durationMs;
    ui.display.textContent = 'Break';

    // Ensure a Skip Break button exists
    let skipBtn = byId('btn-skip-break');
    if(!skipBtn){
      skipBtn = document.createElement('button');
      skipBtn.id = 'btn-skip-break';
      skipBtn.textContent = 'Skip Break';
      const parent = ui.stageLabel?.parentElement || document.body;
      parent.appendChild(skipBtn);
    }

    return new Promise(async resolve => {
      let skipped = false;
      const handler = ()=>{ skipped = true; cleanup(); resolve(true); };
      skipBtn.addEventListener('click', handler);

      const cleanup = ()=>{
        skipBtn.removeEventListener('click', handler);
      };

      const tick = async ()=>{
        if(skipped) return;
        if(now() >= STATE.tEnd){ cleanup(); return resolve(false); }
        const left = STATE.tEnd - now();
        ui.timeLeft.textContent = fmtTime(left);
        ui.bar.style.width = `${100*(1 - left/durationMs)}%`;
        await sleep(200);
        tick();
      };
      tick();
    });
  }

  function waitForSurvey(){
    return new Promise(resolve => {
      const btn = byId('btn-survey-submit');
      const handler = () => {
        if(collectSurvey()){
          btn.removeEventListener('click', handler);
          resolve();
        }
      };
      btn.addEventListener('click', handler);
    });
  }

  function finish(){
    setScreen('finish');
    STATE.phase = 'done';
    const lapsesA = STATE.trials.filter(t=>t.phase==='blockA' && t.lapse).length;
    const lapsesB = STATE.trials.filter(t=>t.phase==='blockB' && t.lapse).length;
    const rtA = median(STATE.trials.filter(t=>t.phase==='blockA' && t.rtMs!=null).map(t=>t.rtMs));
    const rtB = median(STATE.trials.filter(t=>t.phase==='blockB' && t.rtMs!=null).map(t=>t.rtMs));
    const summary = {
      sessionId: STATE.sessionId,
      trials: STATE.trials.length,
      blockATrials: STATE.blockATrials,
      blockBTrials: STATE.blockBTrials,
      lapsesA, lapsesB,
      medianRtA: Math.round(rtA||0),
      medianRtB: Math.round(rtB||0),
      surveys: STATE.surveys,
    };
    ui.summary.textContent = JSON.stringify(summary, null, 2);
    localStorage.setItem(STATE.sessionId, JSON.stringify({
      trials:STATE.trials,
      surveys:STATE.surveys,
      meta:STATE.phasesMeta
    }));
  }

  // ------------------------- Input Handling -------------------------
  window.addEventListener('keydown', (e) => {
    if(STATE.phase==='idle' || !STATE.running) return;
    if(e.key==='Escape'){
      STATE.running = false;
      return;
    }
    if(e.key.toLowerCase()==='o'){
      STATE.selfReportActive = true;
      setTimeout(()=>STATE.selfReportActive=false, 5000);
      pulse(byId('btn-self-report'));
      return;
    }
    if(e.code==='Space'){
      e.preventDefault();
      if(!STATE.currentTrial){
        STATE.currentTrial = { responded:true, key:'Space', rtMs: null, _resolved:false };
      }
      if(STATE.displayOn && STATE.displayOnAt){
        const rt = Math.floor(now() - STATE.displayOnAt);
        if(STATE.currentTrial && STATE.currentTrial.rtMs==null) STATE.currentTrial.rtMs = rt;
      }
      return;
    }
  });

  // Track when stimulus is on screen to compute RT
  const io = new MutationObserver(() => {
    const val = ui.display && ui.display.textContent;
    if (val && /^[0-9]$/.test(val)) {
      STATE.displayOn = true; STATE.displayOnAt = now();
      if (STATE.currentTrial) STATE.currentTrial._resolved = false;
    } else {
      STATE.displayOn = false; STATE.displayOnAt = null;
      if (STATE.currentTrial) STATE.currentTrial._resolved = true;
    }
  });

  if (ui.display) {
    io.observe(ui.display, { childList: true });
  } else {
    console.warn('Missing #display element. Check your index.html: <div id="display" class="display">—</div>');
  }

  // ------------------------- Exports -------------------------
  function exportJSON(){
    const blob = new Blob([JSON.stringify({
      sessionId: STATE.sessionId,
      meta: STATE.phasesMeta,
      trials: STATE.trials,
      surveys: STATE.surveys,
    }, null, 2)], {type:'application/json'});
    download(blob, `${STATE.sessionId}.json`);
  }

  function exportCSV(){
    const header = [
      'sessionId','phase','tStimOn','digit','isTarget','responded','keyDown','rtMs','correct','lapse','riskScore','selfReportActive','vibrated'
    ];
    const lines = [header.join(',')];
    for(const t of STATE.trials){
      lines.push(header.map(k => formatCSV(t[k])).join(','));
    }
    const blob = new Blob([lines.join('\n')], {type:'text/csv'});
    download(blob, `${STATE.sessionId}.csv`);
  }

  function formatCSV(v){
    if(v==null) return '';
    if(typeof v === 'string') return '"' + v.replace(/"/g,'""') + '"';
    return String(v);
  }

  function download(blob, filename){
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------- Utils -------------------------
  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
  function clamp(x,a,b){ return Math.min(b, Math.max(a,x)); }
  function median(arr){
    if(!arr || !arr.length) return null;
    const s=[...arr].sort((a,b)=>a-b);
    const mid=Math.floor(s.length/2);
    return s.length%2?s[mid]:(s[mid-1]+s[mid])/2;
  }
  function medianAbsoluteDeviation(arr){
    if(!arr||arr.length<2) return 0;
    const m=median(arr);
    return median(arr.map(x=>Math.abs(x-m)));
  }
  function tsISO(){ return new Date().toISOString(); }
  function pulse(el){ el?.animate([{transform:'scale(1)'},{transform:'scale(1.05)'},{transform:'scale(1)'}],{duration:250}); }

  window.NeuroBand = {
    feedPhysio(val){
      const v = Number(val);
      if(Number.isFinite(v)){
        window.__NB_physioBoost = clamp(v, -1, 1);
      }
    },
    get state(){ return STATE; },
    vibrate(ms=60){ return tryVibrate(ms); }
  };

  byId('btn-start').addEventListener('click', async () => {
    if(document.fullscreenEnabled){ try{ await document.documentElement.requestFullscreen(); }catch{} }
    setScreen('stage');
    STATE.running = true; STATE.phase = 'baseline';
    STATE.phasesMeta.startedAt = tsISO();
    runSession().catch(err=>{
      console.error(err);
      alert('Error occurred. Check console.');
      finish();
    });
  });

  byId('btn-end-early').addEventListener('click', ()=>{ STATE.running = false; });
  byId('btn-self-report').addEventListener('click', ()=>{
    STATE.selfReportActive = true;
    setTimeout(()=>STATE.selfReportActive=false, 5000);
    pulse(byId('btn-self-report'));
  });

  byId('btn-export-json').addEventListener('click', exportJSON);
  byId('btn-export-csv').addEventListener('click', exportCSV);
  byId('btn-restart').addEventListener('click', ()=>{ newSession(); });

  // Boot session
  newSession();
})();
