// Geomechanics calculator (vanilla ES6 module)
// Assumptions: isotropic, linear elastic medium. All units are SI:
// Depth in meters (m), Density kg/m^3, Vp and Vs in m/s.
// Gravity constant g = 9.81 m/s^2.

const g = 9.81;

// Utility helpers
const el = id => document.getElementById(id);

let rawData = null;
let results = null;

function parseCSV(content) {
  return new Promise((resolve, reject) => {
    Papa.parse(content, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (r) => resolve(r.data),
      error: (err) => reject(err)
    });
  });
}

function parseXLSX(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const first = workbook.SheetNames[0];
      const sheet = workbook.Sheets[first];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: null });
      resolve(json);
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function normalizeHeader(name){
  return String(name||'').trim().toLowerCase();
}

function detectColumns(headers){
  // headers: array of header names
  // tolerant detection: strip punctuation and treat underscores/slashes as separators so
  // headers like "Vs_Km/s" or "Vp_Km/s" are recognized.
  const map = {};
  for(const h of headers){
    const raw = String(h||'');
    const n = normalizeHeader(raw);
    // normalize non-alphanumerics to spaces for easier word-boundary checks
    const cleaned = n.replace(/[^a-z0-9]+/g, ' ');
    if(/\bdepth\b/.test(cleaned)) map.depth = raw;
    if(/\b(depthm|depth m|depth)\b/.test(cleaned)) map.depth = raw;
    if(/\b(dens|density|rho|kg m)\b/.test(cleaned)) map.density = raw;
    if(/\bvp\b|\bp vel\b|\bp velocity\b|\b p velocity\b|\bpwave\b|\bp-wave\b/.test(cleaned)) map.vp = raw;
    // also accept headers starting with vp or containing 'vp '
    if(!map.vp && /^vp\b/.test(cleaned)) map.vp = raw;
    if(/\bvs\b|\bs vel\b|\bs velocity\b|\bshear\b/.test(cleaned)) map.vs = raw;
    if(!map.vs && /^vs\b/.test(cleaned)) map.vs = raw;
  }
  return map;
}

function detectUnitMultiplier(header, hint){
  // Return multiplier to convert the header's numeric values to SI (m or m/s as appropriate)
  // e.g. headers like 'Vs_Km/s' should return 1000 for velocities.
  if(!header) return 1;
  const s = normalizeHeader(String(header)).replace(/[^a-z0-9]+/g, ' ');
  // velocity units
  if(/\bkm\b|\bkm s\b|\bkm\/s\b/.test(s)) return 1000;
  if(/\bm\/s\b|\bm s\b|\bmpersec\b/.test(s)) return 1;
  // depth units
  if(hint === 'depth'){
    if(/\bkm\b/.test(s)) return 1000; // depth in km -> m
    return 1;
  }
  // density units (kg/m3) assumed SI; no conversion unless g/cc detected
  if(hint === 'density'){
    if(/g\/?cc|g cm3|gcm3/.test(s)) return 1000; // g/cc -> multiply by 1000 to get kg/m3
    return 1;
  }
  return 1;
}

function validateAndPrepare(data, cols) {
  // Ensure required columns exist and values are numeric
  const missing = [];
  const keys = ['depth','density','vp','vs'];
  for(const k of keys){ if(!cols[k]) missing.push(k); }
  if(missing.length) throw new Error('Missing columns: ' + missing.join(', '));

  // Build arrays and coerce numbers
  const arr = [];
  for(const row of data){
    // Support headers that include units (e.g. Vp_Km/s). Detect multipliers from header text.
    const depthHeader = cols.depth;
    const densityHeader = cols.density;
    const vpHeader = cols.vp;
    const vsHeader = cols.vs;
    const depthMult = detectUnitMultiplier(depthHeader, 'depth');
    const densMult = detectUnitMultiplier(densityHeader, 'density');
    const vpMult = detectUnitMultiplier(vpHeader, 'velocity');
    const vsMult = detectUnitMultiplier(vsHeader, 'velocity');

    const dRaw = Number(row[depthHeader]);
    const rhoRaw = Number(row[densityHeader]);
    const vpRaw = Number(row[vpHeader]);
    const vsRaw = Number(row[vsHeader]);
    const d = Number.isFinite(dRaw)? dRaw * depthMult : dRaw;
    const rho = Number.isFinite(rhoRaw)? rhoRaw * densMult : rhoRaw;
    const vp = Number.isFinite(vpRaw)? vpRaw * vpMult : vpRaw;
    const vs = Number.isFinite(vsRaw)? vsRaw * vsMult : vsRaw;
    if([d,rho,vp,vs].some(v => v === null || v === undefined || Number.isNaN(v))){
      // skip rows with missing numeric values
      continue;
    }
    arr.push({depth:d,density:rho,vp:vp,vs:vs});
  }
  if(arr.length===0) throw new Error('No valid numeric rows found.');

  // Sort by depth ascending
  arr.sort((a,b)=>a.depth-b.depth);
  return arr;
}

function computeParameters(rows){
  // Input: rows sorted by depth ascending with properties depth,density,vp,vs
  // Outputs additional computed fields for each depth index.
  const n = rows.length;
  const depths = rows.map(r=>r.depth);
  const rho = rows.map(r=>r.density);
  const vp = rows.map(r=>r.vp);
  const vs = rows.map(r=>r.vs);

  // Vertical (overburden) stress: sigma_v(z) = g * integral_0^z rho(z) dz
  // Use trapezoidal integration on discrete samples.
  const sigma_v = new Array(n).fill(0);
  let acc = 0;
  sigma_v[0] = 0; // at top-most sample assume zero overburden at surface
  for(let i=1;i<n;i++){
    const dz = depths[i] - depths[i-1];
    const area = 0.5*(rho[i]+rho[i-1])*dz; // integral of density over this layer
    acc += area;
    sigma_v[i] = acc * g; // multiply by gravity to get stress in Pa (N/m^2)
  }

  // Elastic moduli
  const shearModulus = rho.map((r,i)=>r * Math.pow(vs[i],2)); // G = rho * Vs^2
  // Bulk modulus K = rho * (Vp^2 - 4/3 * Vs^2)
  const bulkModulus = rho.map((r,i)=> r * (Math.pow(vp[i],2) - (4/3)*Math.pow(vs[i],2)) );
  // Lamé first parameter lambda = rho*(Vp^2 - 2Vs^2)
  const lambda = rho.map((r,i)=> r * (Math.pow(vp[i],2) - 2*Math.pow(vs[i],2)) );
  // Poisson's ratio nu = (Vp^2 - 2Vs^2) / (2*(Vp^2 - Vs^2))
  const poisson = vp.map((vpi,i)=>{
    const denom = 2*(Math.pow(vpi,2) - Math.pow(vs[i],2));
    if(Math.abs(denom) < 1e-12) return NaN;
    return (Math.pow(vpi,2) - 2*Math.pow(vs[i],2)) / denom;
  });
  // Young's modulus E = 2G(1+nu)
  const young = shearModulus.map((G,i)=>{
    const nu = poisson[i];
    if(!Number.isFinite(nu)) return NaN;
    return 2*G*(1+nu);
  });
  // Acoustic impedance (P-wave) AI = rho * Vp
  const acousticZ = rho.map((r,i)=> r * vp[i]);
  const shearZ = rho.map((r,i)=> r * vs[i]);
  // P-wave modulus M = rho * Vp^2
  const pModulus = rho.map((r,i)=> r * Math.pow(vp[i],2));

  // Additional derived parameters
  // Vp/Vs ratio
  const vpVsRatio = vp.map((vpi,i)=> vs[i] !== 0 ? vpi / vs[i] : NaN);
  // Impedance gradient dZ/dz (finite differences)
  const impedanceGrad = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(i===0){
      const dz = depths[i+1]-depths[i];
      impedanceGrad[i] = dz? (acousticZ[1]-acousticZ[0])/dz : NaN;
    } else if(i===n-1){
      const dz = depths[i]-depths[i-1];
      impedanceGrad[i] = dz? (acousticZ[i]-acousticZ[i-1])/dz : NaN;
    } else {
      const dz = depths[i+1]-depths[i-1];
      impedanceGrad[i] = dz? (acousticZ[i+1]-acousticZ[i-1])/dz : NaN;
    }
  }
  // Delta acoustic impedance relative to previous sample (useful for reflectivity)
  const deltaZPrev = new Array(n).fill(0);
  for(let i=1;i<n;i++) deltaZPrev[i] = acousticZ[i]-acousticZ[i-1];
  // Lambda over Mu (lambda / G)
  const lambdaOverMu = lambda.map((lam,i)=> shearModulus[i]? lam / shearModulus[i] : NaN);
  // Poisson's ratio computed from bulk and shear moduli: nu = (3K - 2G) / (2*(3K + G))
  const poisson_from_moduli = bulkModulus.map((K,i)=>{
    const G = shearModulus[i];
    const denom = 2*(3*K + G);
    if(Math.abs(denom) < 1e-12) return NaN;
    return (3*K - 2*G) / denom;
  });
  // Brittleness index (simple normalized Young's modulus between min and max)
  const Evals = shearModulus.map((G,i)=>{
    const nu = poisson[i];
    return Number.isFinite(nu) ? 2*G*(1+nu) : NaN;
  }).filter(v=>Number.isFinite(v));
  const E_min = Evals.length? Math.min(...Evals): NaN;
  const E_max = Evals.length? Math.max(...Evals): NaN;
  const brittlenessE = young.map((E,i)=>{
    if(!Number.isFinite(E) || !Number.isFinite(E_min) || E_max===E_min) return NaN;
    return (E - E_min) / (E_max - E_min);
  });

  // Compose results per row
  const out = rows.map((row,i)=>({
    depth: row.depth,
    density: row.density,
    vp: row.vp,
    vs: row.vs,
    vertical_stress_pa: sigma_v[i],
    shear_modulus_pa: shearModulus[i],
    bulk_modulus_pa: bulkModulus[i],
    lame_lambda_pa: lambda[i],
    youngs_modulus_pa: young[i],
    poisson_ratio: poisson[i],
    acoustic_impedance: acousticZ[i],
    shear_impedance: shearZ[i],
    p_modulus_pa: pModulus[i]
    ,vp_vs_ratio: vpVsRatio[i]
    ,impedance_gradient_per_m: impedanceGrad[i]
    ,delta_impedance_prev: deltaZPrev[i]
    ,lambda_over_mu: lambdaOverMu[i]
    ,poisson_from_moduli: poisson_from_moduli[i]
    ,brittleness_e: brittlenessE[i]
  }));
  return out;
}

function renderTable(data){
  const container = el('table-container');
  container.innerHTML = '';
  const table = document.createElement('table');
  const header = document.createElement('thead');
  const keys = Object.keys(data[0]);
  const tr = document.createElement('tr');
  for(const k of keys){
    const th = document.createElement('th');
    th.textContent = k.replace(/_/g,' ');
    tr.appendChild(th);
  }
  header.appendChild(tr);
  table.appendChild(header);

  const body = document.createElement('tbody');
  for(const row of data){
    const tr = document.createElement('tr');
    for(const k of keys){
      const td = document.createElement('td');
      const v = row[k];
      td.textContent = Number.isFinite(v) ? Number(v).toExponential ? Number(v).toPrecision(6) : String(v) : (v===null? '': String(v));
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  container.appendChild(table);

  // Update toggle button label to reflect current visibility
  const toggleBtn = el('toggle-data-btn');
  if(toggleBtn){
    const isVisible = container.style.display !== 'none' && getComputedStyle(container).display !== 'none';
    toggleBtn.textContent = isVisible ? 'Hide Data' : 'Show Data';
  }
}

function populateScatterSelectors(fields){
  const selX = el('scatter-x');
  const selY = el('scatter-y');
  selX.innerHTML = '';
  selY.innerHTML = '';
  for(const f of fields){
    const o1 = document.createElement('option'); o1.value = f; o1.textContent = f; selX.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = f; o2.textContent = f; selY.appendChild(o2);
  }
  selY.selectedIndex = Math.min(1, fields.length-1);
}

function populateProfileParams(fields){
  const sel = el('profile-params');
  if(!sel) return; // not present in this frontend layout
  sel.innerHTML = '';
  for(const f of fields){
    const o = document.createElement('option'); o.value = f; o.textContent = f; sel.appendChild(o);
  }
  // select a sensible default subset
  const defaults = ['vp','vs','density','youngs_modulus_pa','shear_modulus_pa','bulk_modulus_pa'];
  for(let i=0;i<sel.options.length;i++){
    if(defaults.includes(sel.options[i].value)) sel.options[i].selected = true;
  }
}

function populateWellLogParams(fields){
  const sel = el('welllog-params');
  if(!sel) return;
  sel.innerHTML = '';
  for(const f of fields){
    const o = document.createElement('option'); o.value = f; o.textContent = f; sel.appendChild(o);
  }
  // default select a few useful logs
  const defaults = ['density','vp','vs','acoustic_impedance','shear_modulus_pa','youngs_modulus_pa'];
  for(let i=0;i<sel.options.length;i++){
    if(defaults.includes(sel.options[i].value)) sel.options[i].selected = true;
  }
}

function smoothArray(arr, window){
  if(!window || window <= 1) return arr.slice();
  const w = Math.floor(window);
  const half = Math.floor(w/2);
  const out = new Array(arr.length).fill(NaN);
  for(let i=0;i<arr.length;i++){
    let sum = 0, cnt = 0;
    for(let j=i-half;j<=i+half;j++){
      if(j>=0 && j<arr.length && Number.isFinite(arr[j])){ sum += arr[j]; cnt++; }
    }
    out[i] = cnt? sum/cnt : NaN;
  }
  return out;
}

function plotWellLogs(results, fields, options={}){
  if(!fields || !fields.length) return alert('Select at least one field for well-log tracks');
  const n = fields.length;
  const depth = results.map(r=>r.depth);
  const gap = 0.02;
  const totalGap = gap * (n-1);
  // allow overriding track width fraction (fraction per track)
  const defaultWidth = (1 - totalGap) / n;
  const trackWidth = (options.widthFraction && options.widthFraction>0 && options.widthFraction<1) ? options.widthFraction : defaultWidth;
  const traces = [];

  // prepare data arrays (apply smoothing and normalization if requested)
  const seriesList = fields.map(f => results.map(r => {
    const v = r[f];
    return (v===null || v===undefined) ? NaN : Number(v);
  }));
  // smoothing
  if(options.smooth && Number(options.smooth) > 1){
    for(let i=0;i<seriesList.length;i++) seriesList[i] = smoothArray(seriesList[i], Number(options.smooth));
  }
  // normalization
  if(options.normalize){
    for(let i=0;i<seriesList.length;i++){
      const arr = seriesList[i];
      const vals = arr.filter(Number.isFinite);
      const mn = vals.length? Math.min(...vals) : NaN;
      const mx = vals.length? Math.max(...vals) : NaN;
      if(Number.isFinite(mn) && Number.isFinite(mx) && mx !== mn){
        seriesList[i] = arr.map(v => Number.isFinite(v)? (v - mn) / (mx - mn) : NaN);
      } else {
        seriesList[i] = arr.map(_=>NaN);
      }
    }
  }

  for(let i=0;i<n;i++){
    const f = fields[i];
    traces.push({
      x: seriesList[i],
      y: depth,
      name: f,
      mode: 'lines',
      xaxis: 'x'+(i+1),
      hovertemplate: '%{x}<br>Depth: %{y} m<extra></extra>'
    });
  }

  const layout = {height:800, title: 'Well logs', showlegend:false};
  // shared yaxis
  layout['yaxis'] = {autorange:'reversed', title: 'Depth (m)', showgrid: !!options.grid, gridcolor:'#eee'};
  // create xaxis domains
  for(let i=0;i<n;i++){
    // center each track within allocated fraction
    const start = i*(trackWidth+gap);
    const end = start + trackWidth;
    const key = 'xaxis'+(i+1);
    layout[key] = {domain:[start,end], anchor:'y', title: fields[i], type: options.scale||'linear', showgrid: !!options.grid, gridcolor:'#f4f6f8'};
  }
  Plotly.newPlot('welllogs', traces, layout, {responsive:true});
}

function plotProfiles(results, options = {}){
  // options: {fields: [keys], scale: 'linear'|'log', depthOnY: true|false, mode: 'lines'|'markers'|'lines+markers'}
  const defaultFields = ['vp','vs','density','vertical_stress_pa','youngs_modulus_pa','shear_modulus_pa','bulk_modulus_pa'];
  const fields = options.fields && options.fields.length ? options.fields : defaultFields;
  const scale = options.scale || 'linear';
  const depthOnY = options.depthOnY === undefined ? true : options.depthOnY;
  const mode = options.mode || 'lines+markers';

  const depth = results.map(r=>r.depth);
  const traces = fields.map(f=>({
    x: depthOnY ? results.map(r=>r[f]) : depth,
    y: depthOnY ? depth : results.map(r=>r[f]),
    name: f,
    mode: mode,
    hovertemplate: (depthOnY? '%{x}<br>Depth: %{y} m<extra></extra>' : '%{y}<br>Depth: %{x} m<extra></extra>')
  }));

  // Axis config: apply scale (log/linear) to parameter axis, not depth
  const paramAxis = depthOnY ? {title:'Value', type: scale} : {title:'Value', type: scale};
  const depthAxis = depthOnY ? {autorange:'reversed', title:'Depth (m)'} : {autorange:'reversed', title:'Depth (m)'};

  const layout = {
    title: 'Profiles',
    height: 600,
    xaxis: depthOnY ? paramAxis : {title:'Depth (m)'},
    yaxis: depthOnY ? depthAxis : paramAxis,
    legend: {orientation: 'h'}
  };
  Plotly.newPlot('profiles', traces, layout, {responsive:true});
}

function plotScatterMatrix(results, fields){
  // Use Plotly splom for full matrix
  const dims = fields.map(f=>({label:f, values: results.map(r=>r[f])}));
  const trace = {
    type: 'splom',
    dimensions: dims,
    marker: {size:4, color: 'rgba(31,119,180,0.8)'}
  };
  const layout = {title: 'Scatter matrix', height:800};
  Plotly.newPlot('scatter', [trace], layout, {responsive:true});
}

function plotPair(results, xfield, yfield){
  const trace = {
    x: results.map(r=>r[xfield]),
    y: results.map(r=>r[yfield]),
    mode: 'markers',
    type: 'scatter',
    marker:{size:6},
    text: results.map(r=>`Depth: ${r.depth} m`),
    hovertemplate: 'X: %{x}<br>Y: %{y}<br>%{text}<extra></extra>'
  };
  const layout = {title: `${yfield} vs ${xfield}`, xaxis:{title:xfield}, yaxis:{title:yfield}, height:600};
  Plotly.newPlot('scatter',[trace],layout,{responsive:true});
}

function exportResultsCSV(results){
  if(!results || !results.length) return;
  const keys = Object.keys(results[0]);
  const rows = [keys.join(',')];
  for(const r of results){
    const line = keys.map(k=>{
      const v = r[k];
      return (v===null||v===undefined)?'': (Number.isFinite(v)?v: String(v));
    }).join(',');
    rows.push(line);
  }
  const blob = new Blob([rows.join('\n')], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'geomech_results.csv'; a.click(); URL.revokeObjectURL(url);
}

function exportResultsXLSX(results){
  if(!results || !results.length) return;
  const ws = XLSX.utils.json_to_sheet(results);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Results');
  XLSX.writeFile(wb, 'geomech_results.xlsx');
}

// Wire up UI
el('file-input').addEventListener('change', async (ev)=>{
  const f = ev.target.files[0];
  if(!f) return;
  try{
    // If backend compute is selected, keep the File object for upload instead of parsing client-side
    if(el('use-backend') && el('use-backend').checked){
      rawData = { file: f };
      // still attempt to auto-detect headers by reading first few lines if CSV
      if(/\.csv$/i.test(f.name)){
        const text = await f.text();
        const preview = await parseCSV(text);
        const headers = preview.length? Object.keys(preview[0]) : [];
        const auto = detectColumns(headers);
        if(auto.depth) el('col-depth').value = auto.depth;
        if(auto.density) el('col-density').value = auto.density;
        if(auto.vp) el('col-vp').value = auto.vp;
        if(auto.vs) el('col-vs').value = auto.vs;
      }
      alert('File ready for backend compute: ' + f.name);
    } else {
      if(/\.csv$/i.test(f.name)){
        const text = await f.text();
        rawData = await parseCSV(text);
      } else {
        rawData = await parseXLSX(f);
      }
      // Fill default column hints from headers
      const headers = rawData.length? Object.keys(rawData[0]) : [];
      const auto = detectColumns(headers);
      if(auto.depth) el('col-depth').value = auto.depth;
      if(auto.density) el('col-density').value = auto.density;
      if(auto.vp) el('col-vp').value = auto.vp;
      if(auto.vs) el('col-vs').value = auto.vs;
      alert('File parsed: ' + rawData.length + ' rows (including header rows). Use Validate & Compute.');
    }
  }catch(err){
    console.error(err);
    alert('Error parsing file: ' + err.message);
  }
});

// Load sample data via fetch and parse (works when served over http)
const loadSampleBtn = el('load-sample-btn');
if(loadSampleBtn){
  loadSampleBtn.addEventListener('click', async ()=>{
    try{
      const resp = await fetch('sample_data.csv');
      if(!resp.ok) throw new Error('Sample file not found or server required');
      const text = await resp.text();
      rawData = await parseCSV(text);
      const headers = rawData.length? Object.keys(rawData[0]) : [];
      const auto = detectColumns(headers);
      if(auto.depth) el('col-depth').value = auto.depth;
      if(auto.density) el('col-density').value = auto.density;
      if(auto.vp) el('col-vp').value = auto.vp;
      if(auto.vs) el('col-vs').value = auto.vs;
      alert('Sample loaded: ' + rawData.length + ' rows. Click Validate & Compute.');
    }catch(err){
      alert('Could not load sample: ' + err.message + '. Try running a local server.');
      console.error(err);
    }
  });
}

el('validate-btn').addEventListener('click', async ()=>{
  try{
    if(!rawData) throw new Error('No file loaded.');
    const cols = {
      depth: el('col-depth').value || el('col-depth').placeholder,
      density: el('col-density').value || el('col-density').placeholder,
      vp: el('col-vp').value || el('col-vp').placeholder,
      vs: el('col-vs').value || el('col-vs').placeholder,
    };
    if(el('use-backend') && el('use-backend').checked){
      // Send file to backend for compute
      const form = new FormData();
      if(rawData.file) form.append('file', rawData.file);
      else throw new Error('No file available for backend upload');
      const resp = await fetch('/api/compute', {method:'POST', body: form});
      const j = await resp.json();
      if(!resp.ok) throw new Error(j.error || 'Backend error');
      results = j.results;
    } else {
      const prepared = validateAndPrepare(rawData, cols);
      results = computeParameters(prepared);
    }
    renderTable(results);
    // initial profile plot using selected profile params/options (guard missing controls)
    const profileSelOpts = (el('profile-params') && el('profile-params').selectedOptions) ? Array.from(el('profile-params').selectedOptions).map(o=>o.value) : [];
    const profileOpts = {
      fields: profileSelOpts.length ? profileSelOpts : null,
      scale: el('profile-scale') ? el('profile-scale').value : 'linear',
      depthOnY: el('depth-on-y') ? el('depth-on-y').checked : true,
      mode: el('profile-mode') ? el('profile-mode').value : 'lines+markers'
    };
    // only call plotProfiles with explicit fields if provided; otherwise let it use defaults
    if(profileOpts.fields) plotProfiles(results, profileOpts);
    else plotProfiles(results);
    const fields = Object.keys(results[0]);
    populateScatterSelectors(fields);
    populateProfileParams(fields);
    populateWellLogParams(fields);
    if(el('scatter-full').checked){
      plotScatterMatrix(results, fields);
    } else {
      // default pair plots
      plotPair(results, 'vp', 'vs');
    }
  }catch(err){
    alert('Validation/compute error: '+ err.message);
    console.error(err);
  }
});

const _plotWelllogsBtn = el('plot-welllogs-btn');
if(_plotWelllogsBtn){
  _plotWelllogsBtn.addEventListener('click', ()=>{
    if(!results) return alert('Compute results first');
    const sel = el('welllog-params');
    const fields = sel ? Array.from(sel.selectedOptions || []).map(o=>o.value) : [];
    const scale = el('welllog-scale')?.value || 'linear';
    const grid = el('welllog-grid') ? !!el('welllog-grid').checked : false;
    const smooth = el('welllog-smooth') ? Number(el('welllog-smooth').value) : 0;
    const normalize = el('welllog-normalize') ? !!el('welllog-normalize').checked : false;
    const widthFraction = el('welllog-width') ? Number(el('welllog-width').value) : null;
    plotWellLogs(results, fields, {scale, grid, smooth, normalize, widthFraction});
  });
}

const _downloadWelllogsBtn = el('download-welllogs-btn');
if(_downloadWelllogsBtn){
  _downloadWelllogsBtn.addEventListener('click', ()=>{
    const container = document.getElementById('welllogs');
    if(!container) return alert('No welllogs plot to download');
    Plotly.downloadImage('welllogs', {format:'png', width:1400, height:1000, filename:'welllogs'});
  });
}

const _updateProfilesBtn = el('update-profiles-btn');
if(_updateProfilesBtn){
  _updateProfilesBtn.addEventListener('click', ()=>{
    if(!results) return alert('Compute results first');
    const profileOpts = {
      fields: Array.from(el('profile-params').selectedOptions || []).map(o=>o.value),
      scale: el('profile-scale').value || 'linear',
      depthOnY: el('depth-on-y').checked ?? true,
      mode: el('profile-mode').value || 'lines+markers'
    };
    plotProfiles(results, profileOpts);
  });
}

const _downloadProfilesBtn = el('download-profiles-btn');
if(_downloadProfilesBtn){
  _downloadProfilesBtn.addEventListener('click', ()=>{
    const container = document.getElementById('profiles');
    if(!container) return alert('No profiles plot to download');
    Plotly.downloadImage('profiles', {format:'png', width:1200, height:800, filename:'profiles_plot'});
  });
}

const _plotScatterBtn = el('plot-scatter-btn');
if(_plotScatterBtn){
  _plotScatterBtn.addEventListener('click', ()=>{
    if(!results) return alert('Compute results first');
    const xel = el('scatter-x');
    const yel = el('scatter-y');
    const x = xel ? xel.value : null;
    const y = yel ? yel.value : null;
    if(!x||!y) return alert('Select both X and Y fields');
    plotPair(results, x, y);
  });
}

const _exportCsvBtn = el('export-csv-btn');
if(_exportCsvBtn){
  _exportCsvBtn.addEventListener('click', ()=>{
    if(!results) return alert('Compute results first');
    exportResultsCSV(results);
  });
}
const _exportXlsxBtn = el('export-xlsx-btn');
if(_exportXlsxBtn){
  _exportXlsxBtn.addEventListener('click', ()=>{
    if(!results) return alert('Compute results first');
    exportResultsXLSX(results);
  });
}

// If user toggles full scatter
const _scatterFull = el('scatter-full');
if(_scatterFull){
  _scatterFull.addEventListener('change', (e)=>{
    if(!results) return;
    if(e.target.checked){
      const fields = Object.keys(results[0]);
      plotScatterMatrix(results, fields);
    } else {
      plotPair(results, 'vp','vs');
    }
  });
}

// Toggle data view (show/hide parsed table)
const _toggleDataBtn = el('toggle-data-btn');
if(_toggleDataBtn){
  _toggleDataBtn.addEventListener('click', ()=>{
    const container = el('table-container');
    if(!container) return;
    const isHidden = (container.style.display === 'none') || (getComputedStyle(container).display === 'none');
    if(isHidden){
      container.style.display = '';
      _toggleDataBtn.textContent = 'Hide Data';
    } else {
      container.style.display = 'none';
      _toggleDataBtn.textContent = 'Data';
    }
  });
}
